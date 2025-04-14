// main.js
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, clipboard, screen } = require('electron');
const path = require('path'); // Corrected require
const fs = require('fs'); // Corrected require
const os = require('os'); // Corrected require
require('dotenv').config(); // Load .env variables
const { exec } = require('child_process'); // Keep exec for general use maybe
const util = require('util'); // Corrected require
const execPromise = util.promisify(exec); // Use promisified version for cleaner async/await

// --- Single Instance Lock ---
// Request the lock immediately. This is critical for cross-platform reliability.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // If we couldn't get the lock, another instance is already running. Quit.
    console.log("Another instance is already running. Quitting this new instance.");
    app.quit();
} else {
    // --- This is the primary instance ---

    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log("Detected attempt to launch a second instance.");
        console.log("Command line passed to second instance:", commandLine.join(' ')); // Log for debugging

        // --- START MODIFICATION ---
        // Check if the '--stop' argument was passed to the second instance
        // process.argv for the *primary* instance won't have --stop here.
        // We check the commandLine array received from the *second* instance.
        if (commandLine.includes('--stop')) {
            console.log("Received --stop argument from second instance. Quitting application gracefully.");
            // Optional: Add any cleanup needed before quitting
            // mainWindow = null; // Allow window to close naturally if needed
            app.quit(); // Quit the primary instance
        } else {
            console.log("Second instance launched without --stop. Primary instance remains active.");
            // Optional: Bring the main window to the front if it exists and you want that behavior
            if (mainWindow) {
              if (!mainWindow.isVisible()) {
                  // Maybe show it, but maybe not for this app's behavior
                  // mainWindow.showInactive();
              }
              // Focus might be disruptive for this app
              // if (mainWindow.isMinimized()) mainWindow.restore();
              // mainWindow.focus();
            }
        }
        // --- END MODIFICATION ---
    });

    // --- OpenAI Setup ---
    const OpenAI = require('openai');

    if (!process.env.OPENAI_API_KEY) {
        console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
        // Show error later, only if this instance proceeds (in createWindow)
    }
    const openai = process.env.OPENAI_API_KEY ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    }) : null;
    // --- END OpenAI Setup ---

    // --- Platform-Specific Paste Logic --- START NEW SECTION ---

    /**
     * Attempts to paste the clipboard content into the currently active window
     * using platform-specific methods.
     * Hides the recorder window briefly beforehand to help focus shift.
     */
    async function pasteTextIntoActiveWindow() {
        console.log("Main: Attempting to paste into active window.");

        // 1. Hide our window first to allow focus to shift back
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            console.log("Main: Hiding recorder window before pasting.");
            mainWindow.hide();
            // Give the OS a brief moment to process the focus change
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        } else {
            console.log("Main: Window already hidden or destroyed, proceeding with paste attempt.");
        }

        const platform = process.platform;
        let command = '';

        try {
            if (platform === 'darwin') { // macOS
                console.log("Main: Using AppleScript for pasting (Cmd+V).");
                // Simulate Cmd+V keystroke using AppleScript
                command = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
                await execPromise(command);
                console.log("Main: AppleScript paste command executed.");

            } else if (platform === 'win32') { // Windows
                console.log("Main: Using VBScript (via cscript) for pasting (Ctrl+V).");
                // Create a temporary VBS file to send Ctrl+V
                const tempVbsFile = path.join(os.tmpdir(), `paste-${Date.now()}.vbs`);
                const vbsScript = `Set WshShell = WScript.CreateObject("WScript.Shell")\nWshShell.SendKeys "^v"`;
                await fs.promises.writeFile(tempVbsFile, vbsScript);

                // Execute the VBS script using cscript
                command = `cscript //Nologo "${tempVbsFile}"`;
                await execPromise(command);
                console.log("Main: VBScript paste command executed.");

                // Clean up the temporary file
                await fs.promises.unlink(tempVbsFile).catch(err => console.warn("Main: Failed to delete temp VBS file:", err.message));

            } else if (platform === 'linux') { // Linux
                console.log("Main: Using xdotool for pasting (Ctrl+V). Requires xdotool installed.");
                // Check if xdotool exists first (optional but good practice)
                try {
                    await execPromise('command -v xdotool');
                    // Simulate Ctrl+V using xdotool
                    // --clearmodifiers helps ensure other keys aren't stuck down
                    command = `xdotool key --clearmodifiers ctrl+v`;
                    await execPromise(command);
                    console.log("Main: xdotool paste command executed.");
                } catch (xdoCheckError) {
                    console.error("Main: xdotool command not found. Cannot paste automatically.");
                    console.error("Main: Please install xdotool (e.g., 'sudo apt install xdotool' or 'sudo yum install xdotool').");
                    // Optionally show a dialog, but logging might be sufficient
                    // dialog.showErrorBox("Pasting Error", "xdotool is required for automatic pasting on Linux but it was not found. Please install it.");
                    // Don't throw here, just log the inability to paste
                }
                console.warn("Main: Automatic pasting on Linux relies on xdotool and may not work reliably on Wayland display servers.");

            } else {
                console.warn(`Main: Automatic pasting not implemented for platform: ${platform}`);
            }

        } catch (error) {
            console.error(`Main: Failed to execute paste command for platform ${platform}.`);
            console.error("Main: Command:", command); // Log the command that failed
            console.error("Main: Error:", error.message);
            if (error.stderr) {
                console.error("Main: Stderr:", error.stderr);
            }
            // Show a generic error? Maybe not, as clipboard copy still worked.
            // dialog.showErrorBox("Pasting Error", `Failed to automatically paste text: ${error.message}`);
        }
    }

    // --- Platform-Specific Paste Logic --- END NEW SECTION ---


    // --- All other main process code goes inside this 'else' block ---
    let mainWindow = null;
    let isProcessingShortcut = false; // Flag for shortcut processing

    function createWindow() {
        // Show error if key was missing and we are the main instance
        if (!process.env.OPENAI_API_KEY) {
            dialog.showErrorBox("Configuration Error", "OpenAI API Key is missing. Please set OPENAI_API_KEY in the .env file. The application will exit.");
            app.quit();
            return; // Stop window creation
        }

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        const targetX = Math.round(width * 3 / 4);
        const targetY = Math.round(height * 1 / 8);

        const windowWidth = 380;
        const windowHeight = 65;

        mainWindow = new BrowserWindow({
            width: windowWidth,
            height: windowHeight,
            x: targetX,
            y: targetY,
            frame: false,
            resizable: false,
            alwaysOnTop: true,
            show: false,
            skipTaskbar: true,
            transparent: true,
            acceptFirstMouse: true,
            focusable: false, // Keep non-focusable
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: !app.isPackaged,
            }
        });

        mainWindow.loadFile('index.html');

        mainWindow.on('closed', () => {
            mainWindow = null;
        });
    }

    // --- App Lifecycle ---

    app.whenReady().then(() => {
        if (!openai) {
            console.error("Exiting due to missing OpenAI key (already checked in createWindow, but belt-and-suspenders).");
            // Error dialog shown in createWindow if needed
            return;
        }

        if (process.platform === 'darwin') {
            app.dock.hide();
        }

        createWindow(); // Create initial window

        const ret = globalShortcut.register('CmdOrCtrl+Shift+R', () => {
            console.log('Shortcut CmdOrCtrl+Shift+R pressed');

            if (isProcessingShortcut) {
                console.log('Main: Shortcut handling already in progress. Skipping.');
                return;
            }
            isProcessingShortcut = true;
            console.log('Main: Acquired shortcut lock.');

            try {
                if (mainWindow) {
                    if (mainWindow.isDestroyed()) {
                        console.log("Main: mainWindow was destroyed. Recreating.");
                        mainWindow = null;
                        createWindow(); // Recreate
                        if (mainWindow) { // Check if creation was successful
                            mainWindow.once('ready-to-show', () => {
                                mainWindow.showInactive();
                                setTimeout(() => {
                                    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                        console.log("Main: Sending trigger-start-recording after recreation.");
                                        mainWindow.webContents.send('trigger-start-recording');
                                    }
                                    isProcessingShortcut = false; // Release lock after async op
                                    console.log('Main: Released shortcut lock (after recreate/start timer).');
                                }, 100);
                            });
                        } else {
                            // Creation failed (e.g. API key missing now)
                            isProcessingShortcut = false;
                             console.log('Main: Released shortcut lock (createWindow failed).');
                        }
                    } else if (mainWindow.isVisible()) {
                        console.log("Main: Window visible, assuming stop recording & process.");
                        mainWindow.webContents.send('trigger-stop-recording', true); // Should save and process (which includes paste)
                        isProcessingShortcut = false; // Release lock after sending stop
                        console.log('Main: Released shortcut lock (after sending stop).');
                    } else {
                        console.log("Main: Window not visible, showing inactive and triggering record.");
                        mainWindow.showInactive();
                        setTimeout(() => {
                            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                               console.log("Main: Sending trigger-start-recording to renderer.");
                               mainWindow.webContents.send('trigger-start-recording');
                            } else {
                                console.log("Main: Window closed or hidden before start trigger could be sent.");
                            }
                            isProcessingShortcut = false; // Release lock after async op
                            console.log('Main: Released shortcut lock (after show/start timer).');
                        }, 100);
                    }
                } else {
                    console.log("Main: Shortcut triggered but mainWindow is null. Recreating.");
                    createWindow(); // Recreate
                     if (mainWindow) { // Check if creation was successful
                         mainWindow.once('ready-to-show', () => {
                             mainWindow.showInactive();
                             setTimeout(() => {
                                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                   console.log("Main: Sending trigger-start-recording to renderer after recreation.");
                                   mainWindow.webContents.send('trigger-start-recording');
                                }
                                isProcessingShortcut = false; // Release lock after async op
                                console.log('Main: Released shortcut lock (after recreate/start timer - null path).');
                             }, 100);
                         });
                     } else {
                        // Creation failed
                        isProcessingShortcut = false;
                        console.log('Main: Released shortcut lock (createWindow failed - null path).');
                     }
                }
            } catch (error) {
                console.error("Main: Error during shortcut handling:", error);
                isProcessingShortcut = false; // Ensure lock release on error
                console.log('Main: Released shortcut lock due to error.');
            }
        });

        if (!ret) {
            console.error('Main: globalShortcut registration failed');
            dialog.showErrorBox("Error", "Failed to register global shortcut (CmdOrCtrl+Shift+R). Is another application using it?");
        } else {
            console.log('Main: globalShortcut CmdOrCtrl+Shift+R registered successfully.');
        }
    });

    app.on('window-all-closed', function () {
        // On macOS it's common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        // However, this app is more of a utility, so quitting might be desired.
        // If you want macOS behavior, check platform:
        // if (process.platform !== 'darwin') {
        //    app.quit();
        // }
        // For this utility, let's quit on all platforms when the window closes.
        app.quit(); // Simpler behavior
    });

    app.on('will-quit', () => {
        // Unregister all shortcuts.
        globalShortcut.unregisterAll();
        console.log('Main: Unregistered all global shortcuts.');
        // Note: The single instance lock is released automatically by the OS when the app quits.
    });

    // --- IPC Handlers & Other Logic ---
    ipcMain.on('hide-window', () => {
        console.log("Main: Received hide-window request from renderer.");
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            // Note: We might hide the window earlier now in pasteTextIntoActiveWindow
            // This handler is still useful for explicit cancels or errors in renderer.
            mainWindow.hide();
        }
    });

    ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
        console.log('Main: Received audio data for transcription, copying, and pasting.'); // Modified log
        let operationStatus = { success: false, error: null };

        if (!openai) {
            const errorMsg = "OpenAI API key not configured. Cannot transcribe.";
            console.error("Main:", errorMsg);
            operationStatus.error = errorMsg;
            return operationStatus;
         }
        if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
             console.error('Main: No audio data received.');
            operationStatus.error = 'No audio data received by main process.';
            return operationStatus;
        }

        const timestamp = Date.now();
        const tempFileNameWebm = `rec-input-${timestamp}.webm`;
        const tempFileNameMp3 = `rec-output-${timestamp}.mp3`;
        const tempFilePathWebm = path.join(os.tmpdir(), tempFileNameWebm);
        const tempFilePathMp3 = path.join(os.tmpdir(), tempFileNameMp3);

        let webmFileWritten = false;
        let mp3FileCreated = false;

        try {
            // 1. Save original buffer
            const nodeBuffer = Buffer.from(audioDataUint8Array);
            if (nodeBuffer.length === 0) {
                throw new Error("Received audio data resulted in an empty Buffer.");
            }
            await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
            webmFileWritten = true;
            console.log(`Main: Original audio saved to ${tempFilePathWebm} (Size: ${nodeBuffer.length} bytes)`);

            // 2. Convert .webm to .mp3 AND remove silence using ffmpeg
            const silenceFilter = "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-35dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-35dB:detection=peak";
            const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -af "${silenceFilter}" -acodec libmp3lame -ab 48k -ar 16000 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;

            console.log('Main: Executing ffmpeg with silence removal:', ffmpegCommand);
            try {
                const { stdout, stderr } = await execPromise(ffmpegCommand);
                if (stderr && !stderr.includes('Output file is empty')) { console.warn(`Main: ffmpeg stderr output: ${stderr}`); }
                else if (stderr) { console.log(`Main: ffmpeg stderr contained 'Output file is empty' (may be expected if silence removed everything).`); }
                if (stdout) { console.log(`Main: ffmpeg stdout: ${stdout}`); }

                try {
                     await fs.promises.access(tempFilePathMp3, fs.constants.F_OK);
                     const mp3Stats = await fs.promises.stat(tempFilePathMp3);
                     if (mp3Stats.size === 0) {
                         console.log("Main: ffmpeg conversion resulted in an empty MP3 file (likely due to silence removal). Skipping transcription.");
                         operationStatus.success = true;
                         operationStatus.error = "Recording contained only silence or was too quiet after trimming.";
                         // Hide window here since we are returning early
                         if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                           console.log("Main: Hiding window after silent recording.");
                           mainWindow.hide();
                         }
                         // Cleanup handled in finally block
                         return operationStatus;
                     }
                     mp3FileCreated = true;
                     console.log(`Main: Converted and trimmed audio saved to ${tempFilePathMp3} (Size: ${mp3Stats.size} bytes)`);
                } catch (accessOrStatError) {
                     throw new Error(`ffmpeg command may have run but output file not found or is inaccessible: ${tempFilePathMp3}. Error: ${accessOrStatError.message}`);
                }
            } catch (ffmpegError) {
                 console.error('Main: ffmpeg processing failed:', ffmpegError);
                 let errorDetail = ffmpegError.message || 'Unknown ffmpeg error';
                 if (ffmpegError.stderr) { errorDetail += `\nFFmpeg stderr: ${ffmpegError.stderr}`; }
                 if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                      throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
                 }
                 throw new Error(`ffmpeg processing failed: ${errorDetail}`);
            }

            // 3. Send *converted and trimmed* MP3 file to OpenAI
            console.log('Main: Sending trimmed MP3 to OpenAI...');
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempFilePathMp3),
                model: 'whisper-1',
            });

            const transcribedText = transcription.text?.trim();
            console.log('Main: Transcription successful:', transcribedText || "[Empty result]");

            // 4. Copy the text to clipboard AND THEN PASTE
            if (transcribedText && transcribedText.length > 0) {
                try {
                    console.log("Main: Copying text to clipboard...");
                    clipboard.writeText(transcribedText);
                    console.log("Main: Copying finished.");

                    // --- MODIFICATION START: Call paste function ---
                    console.log("Main: Initiating paste into active window...");
                    await pasteTextIntoActiveWindow(); // Wait for paste attempt
                    console.log("Main: Paste attempt finished.");
                    // --- MODIFICATION END ---

                    operationStatus.success = true; // Success means copy *and* paste attempt occurred
                } catch (copyOrPasteError) { // Catch errors from either clipboard or paste function
                     console.error("Main: Clipboard write or paste failed:", copyOrPasteError);
                     const errorMsg = `Transcription succeeded but copying/pasting failed: ${copyOrPasteError.message}. Text is on clipboard if copy succeeded.`;
                     dialog.showErrorBox("Copy/Paste Error", errorMsg);
                     operationStatus.error = errorMsg;
                     operationStatus.success = false; // Failed if copy or paste failed
                     // Ensure window is hidden even if pasting failed after copy
                     if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                         console.log("Main: Hiding window after copy/paste error.");
                         mainWindow.hide();
                     }
                }
            } else {
                console.log("Main: Transcription result was empty, nothing to copy or paste.");
                operationStatus.success = true; // Still "success" in terms of processing
                 // Hide the window even if there was nothing to paste
                 if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                    console.log("Main: Hiding window after empty transcription.");
                    mainWindow.hide();
                }
            }

            return operationStatus;

        } catch (error) {
            console.error('Main: Error during transcription/copying process:', error);
            let errorMessage = 'An unexpected error occurred during processing.';
            if (error instanceof OpenAI.APIError) {
                console.error(`OpenAI API Error: Status=${error.status}, Type=${error.type}, Code=${error.code}, Message=${error.message}`);
                errorMessage = `OpenAI Error (${error.status}): ${error.message || 'Failed to transcribe.'}`;
            } else if (error instanceof Error) {
                errorMessage = error.message;
            }
            // Don't show dialog for silence error, it's handled above now
            if (errorMessage !== "Recording contained only silence or was too quiet after trimming.") {
               dialog.showErrorBox("Processing Failed", errorMessage);
            }
            operationStatus.error = errorMessage;
            operationStatus.success = false;
            // Hide the window on general failure too
             if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                console.log("Main: Hiding window after processing error.");
                mainWindow.hide();
            }
            return operationStatus;
        } finally {
            // Cleanup temp files
            if (webmFileWritten) {
                fs.promises.unlink(tempFilePathWebm)
                    .then(() => console.log(`Main: Deleted temp webm file ${tempFilePathWebm}`))
                    .catch(err => console.error(`Main: Failed to delete temp webm file ${tempFilePathWebm}:`, err));
            }
            if (mp3FileCreated) {
                fs.promises.unlink(tempFilePathMp3)
                    .then(() => console.log(`Main: Deleted temp mp3 file ${tempFilePathMp3}`))
                    .catch(err => console.error(`Main: Failed to delete temp mp3 file ${tempFilePathMp3}:`, err));
            }
            console.log("Main: Transcription/Paste IPC handler finished.");
            // Note: Window hiding is now handled within the try/catch blocks or paste function
        }
    });
    // --- END IPC Handler ---

} // --- End of the 'else' block for the primary instance ---