// main.js
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const OpenAI = require('openai'); // Ensure OpenAI is required

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

// --- ADDED: Variable to store path for retry ---
let lastFailedMp3Path = null; // Stores the path to the MP3 if transcription fails retryably

if (!gotTheLock) {
    console.log("Another instance is already running. Quitting this new instance.");
    app.quit();
} else {
    // --- This is the primary instance ---

    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log("Detected attempt to launch a second instance.");
        console.log("Command line passed to second instance:", commandLine.join(' '));

        if (commandLine.includes('--stop')) {
            console.log("Received --stop argument from second instance. Quitting application gracefully.");
            app.quit();
        } else {
            console.log("Second instance launched without --stop. Primary instance remains active.");
            if (mainWindow) {
              // Focus/showing logic remains unchanged
            }
        }
    });

    // --- OpenAI Setup ---
    if (!process.env.OPENAI_API_KEY) {
        console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
    }
    const openai = process.env.OPENAI_API_KEY ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    }) : null;
    // --- END OpenAI Setup ---

    // --- Platform-Specific Paste Logic ---
    async function pasteTextIntoActiveWindow() {
        console.log("Main: Attempting to paste into active window.");
        let windowWasVisible = false; // Track if window was visible before hiding

        // 1. Hide our window first (only if visible and not pending retry)
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            // Check if we are hiding specifically for paste, not due to a pending retry
            if (!lastFailedMp3Path) {
                console.log("Main: Hiding recorder window before pasting.");
                mainWindow.hide();
                windowWasVisible = true;
                 // Give the OS a brief moment to process the focus change
                await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
            } else {
                 console.log("Main: Paste attempt occurring, but not hiding window due to pending retry.");
            }
        } else {
            console.log("Main: Window already hidden or destroyed, proceeding with paste attempt.");
        }

        const platform = process.platform;
        let command = '';

        try {
            if (platform === 'darwin') {
                console.log("Main: Using AppleScript for pasting (Cmd+V).");
                command = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
                await execPromise(command);
                console.log("Main: AppleScript paste command executed.");
            } else if (platform === 'win32') {
                console.log("Main: Using VBScript (via cscript) for pasting (Ctrl+V).");
                const tempVbsFile = path.join(os.tmpdir(), `paste-${Date.now()}.vbs`);
                const vbsScript = `Set WshShell = WScript.CreateObject("WScript.Shell")\nWshShell.SendKeys "^v"`;
                await fs.promises.writeFile(tempVbsFile, vbsScript);
                command = `cscript //Nologo "${tempVbsFile}"`;
                await execPromise(command);
                console.log("Main: VBScript paste command executed.");
                await fs.promises.unlink(tempVbsFile).catch(err => console.warn("Main: Failed to delete temp VBS file:", err.message));
            } else if (platform === 'linux') {
                console.log("Main: Using xdotool for pasting (Ctrl+V). Requires xdotool installed.");
                try {
                    await execPromise('command -v xdotool');
                    command = `xdotool key --clearmodifiers ctrl+v`;
                    await execPromise(command);
                    console.log("Main: xdotool paste command executed.");
                } catch (xdoCheckError) {
                    console.error("Main: xdotool command not found. Cannot paste automatically.");
                    console.error("Main: Please install xdotool (e.g., 'sudo apt install xdotool' or 'sudo yum install xdotool').");
                }
                console.warn("Main: Automatic pasting on Linux relies on xdotool and may not work reliably on Wayland display servers.");
            } else {
                console.warn(`Main: Automatic pasting not implemented for platform: ${platform}`);
            }
        } catch (error) {
            console.error(`Main: Failed to execute paste command for platform ${platform}.`);
            console.error("Main: Command:", command);
            console.error("Main: Error:", error.message);
            if (error.stderr) console.error("Main: Stderr:", error.stderr);

            // If paste failed, but window was hidden for it, potentially show it again?
            // Or rely on the error dialog / retry state to keep it visible?
            // Let's keep it hidden for now to avoid potential focus issues.
            // If retry is needed, the window will remain visible anyway.
        }
    }
    // --- END Platform-Specific Paste Logic ---

    let mainWindow = null;
    let isProcessingShortcut = false;

    function createWindow() {
        // ... (existing createWindow code remains unchanged) ...
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
            return;
        }

        if (process.platform === 'darwin') {
            app.dock.hide();
        }

        createWindow();

        // --- MODIFIED: Shortcut handling ---
        const ret = globalShortcut.register('CmdOrCtrl+Shift+R', () => {
            console.log('Shortcut CmdOrCtrl+Shift+R pressed');
            if (isProcessingShortcut) {
                console.log('Main: Shortcut handling already in progress. Skipping.');
                return;
            }
            isProcessingShortcut = true;
            console.log('Main: Acquired shortcut lock.');

            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                     // NEW: Check if we are in an error/retry state
                     if (lastFailedMp3Path) {
                         console.log("Main: Shortcut pressed while in error state. Triggering cancel.");
                         cancelPendingRetry(); // Call the cancel function (defined later)
                         // No need to send anything to renderer, cancel handles hiding
                     } else if (mainWindow.isVisible()) {
                         // Window is visible: could be recording or idle. Send stop signal.
                         // Renderer handles the current state (stop recording or ignore if idle).
                         console.log("Main: Window visible, sending trigger-stop-recording (true).");
                         mainWindow.webContents.send('trigger-stop-recording', true);
                     } else {
                        // Window not visible: show and trigger start
                        console.log("Main: Window not visible, showing inactive and triggering record.");
                        mainWindow.showInactive();
                        setTimeout(() => {
                           if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                              console.log("Main: Sending trigger-start-recording to renderer.");
                              mainWindow.webContents.send('trigger-start-recording');
                           }
                        }, 100); // Keep delay
                     }
                } else {
                    // Window doesn't exist: create and start
                    console.log("Main: Shortcut triggered but mainWindow is null/destroyed. Recreating.");
                    createWindow();
                    if (mainWindow) {
                        mainWindow.once('ready-to-show', () => {
                            mainWindow.showInactive();
                            setTimeout(() => {
                                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                    console.log("Main: Sending trigger-start-recording after recreation.");
                                    mainWindow.webContents.send('trigger-start-recording');
                                }
                            }, 100);
                        });
                    }
                }
            } catch (error) {
                 console.error("Main: Error during shortcut handling:", error);
             } finally {
                 // Release lock AFTER any potential async operations inside might have started
                 // Using setTimeout to ensure it releases after the current execution path completes
                 setTimeout(() => {
                    isProcessingShortcut = false;
                    console.log('Main: Released shortcut lock.');
                 }, 0);
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
        app.quit();
    });

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        console.log('Main: Unregistered all global shortcuts.');
        // Clean up any lingering temp file on quit
        if (lastFailedMp3Path) {
             console.log("Main: Cleaning up lingering temp file on quit:", lastFailedMp3Path);
             cleanupTempFile(lastFailedMp3Path, "quit cleanup");
             lastFailedMp3Path = null;
         }
    });

    // --- Helper Functions ---

    /** Safely deletes a temporary file */
    function cleanupTempFile(filePath, context = "general cleanup") {
        if (filePath) {
            fs.promises.unlink(filePath)
                .then(() => console.log(`Main: Deleted temp file (${context}): ${filePath}`))
                .catch(err => console.error(`Main: Failed to delete temp file (${context}) ${filePath}:`, err));
        }
    }

    /** Hides the main window if it exists and is visible, respecting retry state */
    function hideMainWindow() {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            if (!lastFailedMp3Path) {
                console.log("Main: Hiding window.");
                mainWindow.hide();
            } else {
                console.log("Main: Keeping window visible due to pending retry.");
            }
        }
    }

    /** Determines if an error is likely temporary and worth retrying */
    function isRetryableError(error) {
        if (error instanceof OpenAI.APIError) {
            const retryableStatuses = [408, 429, 500, 502, 503, 504];
            if (retryableStatuses.includes(error.status)) {
                console.log(`Main: Retryable OpenAI error status: ${error.status}`);
                return true;
            }
            // Check for specific error codes/types if needed
            // e.g., if (error.code === 'rate_limit_exceeded') return true;
        }
        // Add checks for generic network errors (e.g., from execPromise or fs) if applicable
        // For now, focusing on OpenAI API errors.
        console.log("Main: Non-retryable error encountered:", error.message);
        return false;
    }

    /** Core transcription and pasting logic */
    async function _performTranscriptionAndPasting(mp3FilePath) {
        let operationStatus = { success: false, error: null, retryable: false };

        if (!mp3FilePath) {
            operationStatus.error = "Internal error: No MP3 file path provided for transcription.";
            return operationStatus;
        }

        try {
            // Check if file exists before sending
            await fs.promises.access(mp3FilePath, fs.constants.R_OK);

            console.log(`Main: Sending MP3 to OpenAI: ${mp3FilePath}`);
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(mp3FilePath),
                model: 'whisper-1',
            });

            const transcribedText = transcription.text?.trim();
            console.log('Main: Transcription successful:', transcribedText || "[Empty result]");

            if (transcribedText && transcribedText.length > 0) {
                try {
                    console.log("Main: Copying text to clipboard...");
                    clipboard.writeText(transcribedText);
                    console.log("Main: Copying finished.");

                    console.log("Main: Initiating paste into active window...");
                    await pasteTextIntoActiveWindow(); // This might hide the window
                    console.log("Main: Paste attempt finished.");
                    operationStatus.success = true;
                } catch (copyOrPasteError) {
                    console.error("Main: Clipboard write or paste failed:", copyOrPasteError);
                    // This is generally not retryable from OpenAI's perspective
                    operationStatus.error = `Transcription succeeded but copy/paste failed: ${copyOrPasteError.message}. Text is on clipboard.`;
                    operationStatus.success = false; // Mark as failed overall
                    operationStatus.retryable = false;
                    // No dialog here, let caller handle UI
                }
            } else {
                console.log("Main: Transcription result was empty, nothing to copy or paste.");
                operationStatus.success = true; // Processing technically succeeded
            }
            return operationStatus;

        } catch (error) {
            console.error('Main: Error during transcription/copying process:', error);
            let errorMessage = 'An unexpected error occurred during processing.';
            if (error instanceof OpenAI.APIError) {
                errorMessage = `OpenAI Error (${error.status}): ${error.message || 'Failed to transcribe.'}`;
                operationStatus.retryable = isRetryableError(error);
            } else if (error.code === 'ENOENT') {
                 errorMessage = `Internal error: MP3 file not found at ${mp3FilePath}.`;
                 operationStatus.retryable = false; // Cannot retry if file is gone
            } else if (error instanceof Error) {
                errorMessage = error.message;
                // Assume other errors (like fs access denied, unexpected exec errors) are not retryable
                operationStatus.retryable = false;
            }
            operationStatus.error = errorMessage;
            operationStatus.success = false;
            return operationStatus;
        }
    }

    // --- IPC Handlers ---

    ipcMain.on('hide-window', () => {
        console.log("Main: Received hide-window request from renderer.");
        hideMainWindow(); // Use the helper function
    });

    ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
        console.log('Main: Initiating new transcription process.');
        let operationResult = { success: false, error: null, retryable: false }; // Default result

        // --- Cleanup previous state ---
        if (lastFailedMp3Path) {
            console.warn("Main: Starting new transcription, cleaning up previous failed file:", lastFailedMp3Path);
            cleanupTempFile(lastFailedMp3Path, "new transcription started");
            lastFailedMp3Path = null;
        }
        // --- End Cleanup ---

        if (!openai) { /* ... (existing error handling) ... */ return operationResult; }
        if (!audioDataUint8Array || audioDataUint8Array.length === 0) { /* ... */ return operationResult; }

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
            if (nodeBuffer.length === 0) throw new Error("Received audio data resulted in an empty Buffer.");
            await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
            webmFileWritten = true;
            console.log(`Main: Original audio saved to ${tempFilePathWebm}`);

            // 2. Convert .webm to .mp3 with silence removal
            const silenceFilter = "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-35dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-35dB:detection=peak";
            const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -af "${silenceFilter}" -acodec libmp3lame -ab 48k -ar 16000 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
            console.log('Main: Executing ffmpeg:', ffmpegCommand);
            try {
                await execPromise(ffmpegCommand);
                const mp3Stats = await fs.promises.stat(tempFilePathMp3);
                if (mp3Stats.size === 0) {
                    console.log("Main: ffmpeg resulted in empty MP3 (silence). Skipping transcription.");
                    operationResult = { success: true, error: "Recording contained only silence.", retryable: false };
                    // Let finally block handle cleanup and hide
                    return operationResult;
                }
                mp3FileCreated = true;
                console.log(`Main: Converted audio saved to ${tempFilePathMp3}`);
            } catch (ffmpegError) {
                console.error('Main: ffmpeg processing failed:', ffmpegError);
                let errorDetail = ffmpegError.message || 'Unknown ffmpeg error';
                if (ffmpegError.stderr) { errorDetail += `\nFFmpeg stderr: ${ffmpegError.stderr}`; }
                 if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                     throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
                 }
                throw new Error(`ffmpeg processing failed: ${errorDetail}`);
            }

            // 3. Perform Transcription & Pasting using the helper
            operationResult = await _performTranscriptionAndPasting(tempFilePathMp3);

            return operationResult; // Return result from helper

        } catch (error) { // Catches errors from saving, ffmpeg setup, etc. (before _performTranscriptionAndPasting)
            console.error('Main: Error during pre-transcription process:', error);
            operationResult = { success: false, error: error.message || "Failed during audio preparation.", retryable: false };
            // Don't show dialog here for setup errors, return the status
            return operationResult;
        } finally {
             console.log("Main: 'transcribe-audio' handler final block executing. Result:", operationResult);
            // Cleanup based on the final operation result
            if (operationResult.retryable) {
                console.log("Main: Transcription failed retryably. Storing MP3 path:", tempFilePathMp3);
                lastFailedMp3Path = tempFilePathMp3; // Keep MP3
                if (webmFileWritten) cleanupTempFile(tempFilePathWebm, "retryable error cleanup"); // Delete WebM
                // DO NOT hide window
            } else {
                 // Success OR non-retryable failure
                 if (webmFileWritten) cleanupTempFile(tempFilePathWebm, "final cleanup (success or non-retryable)");
                 if (mp3FileCreated) cleanupTempFile(tempFilePathMp3, "final cleanup (success or non-retryable)");

                 // Show error dialog ONLY for non-retryable errors that weren't silence related
                 if (!operationResult.success && !operationResult.retryable && operationResult.error && !operationResult.error.includes("silence")) {
                     // Exclude copy/paste errors as they are less critical and text might be on clipboard
                     if (!operationResult.error.includes("copy/paste failed")) {
                        dialog.showErrorBox("Processing Failed", operationResult.error);
                     } else {
                         // Optionally show a less intrusive notification for copy/paste failures
                         console.warn("Main: Copy/paste failed after transcription. Text is on clipboard.");
                     }
                 }

                 // Hide window on success or non-retryable error
                 hideMainWindow();
            }
            console.log("Main: 'transcribe-audio' handler finished.");
        }
    });

    ipcMain.handle('retry-transcription', async () => {
        console.log("Main: Received retry-transcription request.");
        let operationResult = { success: false, error: null, retryable: false };

        if (!lastFailedMp3Path) {
            console.error("Main: Retry requested but no failed MP3 path is stored.");
            return { success: false, error: "No previous failed attempt found to retry.", retryable: false };
        }

        const pathToRetry = lastFailedMp3Path; // Store the path locally
        lastFailedMp3Path = null; // Clear the global path BEFORE attempting retry

        console.log("Main: Attempting retry with file:", pathToRetry);
        try {
            operationResult = await _performTranscriptionAndPasting(pathToRetry);

            // Process result
            if (operationResult.success) {
                console.log("Main: Retry successful.");
                cleanupTempFile(pathToRetry, "successful retry cleanup"); // Delete file on success
                hideMainWindow();
            } else if (operationResult.retryable) {
                console.log("Main: Retry failed retryably. Re-storing MP3 path:", pathToRetry);
                lastFailedMp3Path = pathToRetry; // Restore the path for another retry
                // DO NOT hide window, DO NOT delete file
            } else {
                // Non-retryable failure on retry
                console.error("Main: Retry failed non-retryably:", operationResult.error);
                 // Show error dialog for non-retryable errors during retry
                 if (operationResult.error && !operationResult.error.includes("copy/paste failed")) {
                    dialog.showErrorBox("Retry Failed", operationResult.error);
                 } else if (operationResult.error) {
                     console.warn("Main: Copy/paste failed during retry. Text is on clipboard.");
                 }
                cleanupTempFile(pathToRetry, "non-retryable retry failure cleanup"); // Delete file
                hideMainWindow();
            }
            return operationResult; // Return the result from the helper

        } catch (error) { // Catch unexpected errors during the retry handler itself
             console.error('Main: Unexpected error during retry handler:', error);
             operationResult = { success: false, error: `Unexpected retry error: ${error.message}`, retryable: false };
             cleanupTempFile(pathToRetry, "unexpected retry error cleanup"); // Clean up file
             lastFailedMp3Path = null; // Ensure path is cleared
             hideMainWindow();
             return operationResult;
        } finally {
             console.log("Main: 'retry-transcription' handler finished.");
        }

    });

    // --- NEW: Cancel Retry Handler ---
    function cancelPendingRetry() {
         console.log("Main: Cancelling pending retry action.");
         if (lastFailedMp3Path) {
             const pathToCancel = lastFailedMp3Path;
             lastFailedMp3Path = null; // Clear immediately
             cleanupTempFile(pathToCancel, "cancel retry");
             hideMainWindow(); // Hide after cancelling
         } else {
             console.log("Main: No pending retry to cancel.");
             // If cancel is triggered (e.g., by shortcut) when not in retry state, just ensure window is hidden
             hideMainWindow();
         }
     }

    ipcMain.on('cancel-retry', () => {
        console.log("Main: Received cancel-retry request from renderer.");
        cancelPendingRetry();
    });
    // --- END IPC Handlers ---

} // --- End of the 'else' block for the primary instance ---