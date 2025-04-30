```javascript
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

// --- Variable to store path for retry ---
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
                    throw new Error("xdotool not found. Automatic paste failed."); // Re-throw to indicate failure
                }
                console.warn("Main: Automatic pasting on Linux relies on xdotool and may not work reliably on Wayland display servers.");
            } else {
                console.warn(`Main: Automatic pasting not implemented for platform: ${platform}`);
                throw new Error(`Automatic paste not supported on ${platform}.`); // Throw to indicate failure
            }
        } catch (error) {
            console.error(`Main: Failed to execute paste command for platform ${platform}.`);
            console.error("Main: Command:", command);
            console.error("Main: Error:", error.message);
            if (error.stderr) console.error("Main: Stderr:", error.stderr);
            // Re-throw the error so the caller knows pasting failed
            throw error;
        }
    }
    // --- END Platform-Specific Paste Logic ---

    let mainWindow = null;
    let isProcessingShortcut = false;

    function createWindow() {
        // ... (existing createWindow code remains unchanged) ...
         if (!process.env.OPENAI_API_KEY) {
            // Show error early if key is missing during initial setup
            dialog.showErrorBox("Configuration Error", "OpenAI API Key is missing. Please set OPENAI_API_KEY in the .env file. The application will exit.");
            app.quit();
            return; // Stop window creation
        }

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        // Position near top-right, adjust as needed
        const windowWidth = 380;
        const windowHeight = 75; // Slightly increased height for potential retry button
        const marginX = 20;
        const marginY = 50;

        const targetX = width - windowWidth - marginX;
        const targetY = marginY;


        mainWindow = new BrowserWindow({
            width: windowWidth,
            height: windowHeight,
            x: targetX,
            y: targetY,
            frame: false,
            resizable: false,
            alwaysOnTop: true,
            show: false, // Initially hidden
            skipTaskbar: true, // Don't show in taskbar
            transparent: true, // Enable transparency
            acceptFirstMouse: true, // Allow click-through for first click
            focusable: false, // Prevent stealing focus
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: !app.isPackaged, // Enable DevTools in development
            }
        });

        mainWindow.loadFile('index.html');

        // Optional: Open DevTools automatically if not packaged
        // if (!app.isPackaged) {
        //     mainWindow.webContents.openDevTools({ mode: 'detach' });
        // }

        mainWindow.on('closed', () => {
            mainWindow = null;
        });

        // Handle focus loss - hide the window unless we are in a retry state
        mainWindow.on('blur', () => {
            console.log("Main: Window blurred.");
            hideMainWindow(); // Use the helper which respects retry state
        });
    }

    // --- App Lifecycle ---
    app.whenReady().then(() => {
        if (!openai) {
            // Should have been caught by createWindow, but double-check
            console.error("Exiting due to missing OpenAI key.");
            app.quit(); // Ensure exit if somehow reached here without key
            return;
        }

        if (process.platform === 'darwin') {
            app.dock.hide(); // Hide dock icon on macOS
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
                     // Check if we are in an error/retry state
                     if (lastFailedMp3Path) {
                         console.log("Main: Shortcut pressed while in error state. Triggering cancel.");
                         cancelPendingRetry(); // Cancel the pending retry and hide
                     } else if (mainWindow.isVisible()) {
                         // Window is visible: could be recording or idle/success/error. Send stop signal.
                         // Renderer handles the current state (stop recording, discard success, or handle idle).
                         console.log("Main: Window visible, sending trigger-stop-recording (true).");
                         mainWindow.webContents.send('trigger-stop-recording', true); // true indicates shortcut triggered stop
                     } else {
                        // Window not visible: show and trigger start
                        console.log("Main: Window not visible, showing inactive and triggering record.");
                        // Ensure window is created if somehow destroyed
                        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.showInactive(); // Show without stealing focus
                            // Use setTimeout to ensure the window is shown before sending the message
                            setTimeout(() => {
                               if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                  console.log("Main: Sending trigger-start-recording to renderer.");
                                  mainWindow.webContents.send('trigger-start-recording');
                               } else {
                                   console.log("Main: Window was not visible after showInactive; cannot start recording.");
                               }
                            }, 50); // Reduced delay slightly
                        }
                     }
                } else {
                    // Window doesn't exist: create and start
                    console.log("Main: Shortcut triggered but mainWindow is null/destroyed. Recreating.");
                    createWindow();
                    if (mainWindow) {
                        // Wait for window to be ready before showing and triggering
                        mainWindow.once('ready-to-show', () => {
                            mainWindow.showInactive();
                            setTimeout(() => {
                                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                    console.log("Main: Sending trigger-start-recording after recreation.");
                                    mainWindow.webContents.send('trigger-start-recording');
                                }
                            }, 50);
                        });
                    } else {
                         console.error("Main: Failed to recreate window on shortcut trigger.");
                    }
                }
            } catch (error) {
                 console.error("Main: Error during shortcut handling:", error);
             } finally {
                 // Release lock AFTER any potential async operations inside might have started
                 setTimeout(() => {
                    isProcessingShortcut = false;
                    console.log('Main: Released shortcut lock.');
                 }, 0);
             }
        });

        if (!ret) {
            console.error('Main: globalShortcut registration failed');
            dialog.showErrorBox("Error", "Failed to register global shortcut (CmdOrCtrl+Shift+R). Is another application using it? Please check system settings or conflicting apps.");
            // Optionally quit if the shortcut is essential
            // app.quit();
        } else {
            console.log('Main: globalShortcut CmdOrCtrl+Shift+R registered successfully.');
        }
    });

    app.on('window-all-closed', function () {
        // On macOS it's common to stay active until Cmd+Q
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', function () {
        // On macOS re-create window if dock icon is clicked and no windows open
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
         // Optional: Show the main window if it exists but is hidden
         if (mainWindow && !mainWindow.isVisible()) {
             // mainWindow.show(); // Or showInactive() if preferred
         }
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
                .catch(err => {
                    // Log ENOENT (File Not Found) less severely as it might have been cleaned already
                    if (err.code === 'ENOENT') {
                         console.warn(`Main: Temp file already deleted? (${context}) ${filePath}:`, err.message);
                    } else {
                         console.error(`Main: Failed to delete temp file (${context}) ${filePath}:`, err);
                    }
                });
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
        } else {
             console.log("Main: Window already hidden or destroyed, no action needed for hideMainWindow.");
        }
    }

    /** Determines if an error is likely temporary and worth retrying */
    function isRetryableError(error) {
        if (error instanceof OpenAI.APIError) {
            // 408 Request Timeout, 429 Rate Limit, 5xx Server Errors
            const retryableStatuses = [408, 429, 500, 502, 503, 504];
            if (retryableStatuses.includes(error.status)) {
                console.log(`Main: Retryable OpenAI error status: ${error.status}`);
                return true;
            }
            // Potentially check for specific error codes/types for overload etc.
            // if (error.code === 'server_busy' || error.type === 'server_error') return true;
        }
        // Add checks for generic network errors here if needed (e.g., ECONNRESET, ETIMEDOUT)
        // if (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
        //     console.log(`Main: Retryable network error: ${error.code}`);
        //     return true;
        // }
        console.log("Main: Non-retryable error encountered:", error?.message || error);
        return false;
    }

    /** Core transcription and pasting logic */
    async function _performTranscriptionAndPasting(mp3FilePath) {
        let operationStatus = { success: false, error: null, retryable: false, transcriptionText: null };

        if (!mp3FilePath) {
            operationStatus.error = "Internal error: No MP3 file path provided for transcription.";
            return operationStatus;
        }
        if (!openai) {
            operationStatus.error = "OpenAI client not initialized (missing API key?).";
             return operationStatus;
        }

        try {
            // Check if file exists and is readable
            await fs.promises.access(mp3FilePath, fs.constants.R_OK);
            console.log(`Main: Sending MP3 to OpenAI: ${mp3FilePath}`);

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(mp3FilePath),
                model: 'whisper-1',
            });

            const transcribedText = transcription.text?.trim();
            console.log('Main: Transcription successful:', transcribedText || "[Empty result]");
            operationStatus.transcriptionText = transcribedText; // Store text even if empty

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
                    // Mark as success=false but provide context. Not retryable from OpenAI's perspective.
                    operationStatus.error = `Paste failed: ${copyOrPasteError.message}. Text copied.`;
                    operationStatus.success = false; // Overall operation failed due to paste issue
                    operationStatus.retryable = false;
                }
            } else {
                console.log("Main: Transcription result was empty. Nothing to copy or paste.");
                operationStatus.success = true; // Technically successful transcription, just empty.
                operationStatus.error = "Transcription returned empty result."; // Provide context
            }
            return operationStatus;

        } catch (error) {
            console.error('Main: Error during transcription/copying process:', error);
            let errorMessage = 'An unexpected error occurred during processing.';
             operationStatus.retryable = isRetryableError(error); // Check if retryable first

            if (error instanceof OpenAI.APIError) {
                errorMessage = `OpenAI Error (${error.status}): ${error.message || 'Failed to transcribe.'}`;
            } else if (error.code === 'ENOENT') {
                 errorMessage = `Internal error: MP3 file not found at ${mp3FilePath}.`;
                 operationStatus.retryable = false; // Cannot retry if file is gone
            } else if (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
                 errorMessage = `Network Error: ${error.message}`;
                 // Network errors are often retryable
                 operationStatus.retryable = true;
             } else if (error instanceof Error) {
                errorMessage = error.message;
                // Assume other errors are not retryable unless specifically handled
            }
            operationStatus.error = errorMessage;
            operationStatus.success = false;
            return operationStatus;
        }
    }

    /** Helper to format bytes */
    function formatBytes(bytes, decimals = 1) {
        if (!bytes || bytes === 0) return '0 Bytes'; // Handle null/undefined/zero
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        try { // Add try-catch for potential Math.log(0) or negative bytes
             const i = Math.floor(Math.log(bytes) / Math.log(k));
             // Ensure index i is within bounds
             const safeIndex = Math.max(0, Math.min(i, sizes.length - 1));
             return parseFloat((bytes / Math.pow(k, safeIndex)).toFixed(dm)) + ' ' + sizes[safeIndex];
        } catch (e) {
             console.warn(`Error formatting bytes: ${bytes}`, e);
             return `${bytes} Bytes`; // Fallback
        }
    }

    // --- IPC Handlers ---

    ipcMain.on('hide-window', () => {
        console.log("Main: Received hide-window request from renderer.");
        hideMainWindow(); // Use the helper function which respects retry state
    });

    ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
        console.log('Main: Initiating new transcription process.');
        let operationResult = { success: false, error: null, retryable: false, transcriptionText: null }; // Default result

        // --- Cleanup previous state ---
        if (lastFailedMp3Path) {
            console.warn("Main: Starting new transcription, cleaning up previous failed file:", lastFailedMp3Path);
            cleanupTempFile(lastFailedMp3Path, "new transcription started");
            lastFailedMp3Path = null;
        }
        // --- End Cleanup ---

        if (!openai) {
            operationResult.error = "OpenAI API key is not configured.";
            console.error("Main:", operationResult.error);
            return operationResult;
         }
        if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
            operationResult.error = "No audio data received.";
             console.error("Main:", operationResult.error);
            return operationResult;
        }

        const timestamp = Date.now();
        const tempFileNameWebm = `rec-input-${timestamp}.webm`;
        const tempFileNameMp3 = `rec-output-${timestamp}.mp3`;
        const tempFilePathWebm = path.join(os.tmpdir(), tempFileNameWebm);
        const tempFilePathMp3 = path.join(os.tmpdir(), tempFileNameMp3);
        let webmFileWritten = false;
        let mp3FileCreated = false;
        let originalSizeBytes = 0; // Initialize here

        try {
            // 1. Save original buffer
            const nodeBuffer = Buffer.from(audioDataUint8Array);
            originalSizeBytes = nodeBuffer.length; // Get size before writing
            if (nodeBuffer.length === 0) throw new Error("Received audio data resulted in an empty Buffer.");
            await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
            webmFileWritten = true;
            console.log(`Main: Original audio (${formatBytes(originalSizeBytes)}) saved to ${tempFilePathWebm}`);


            // 2. Convert .webm to .mp3 with silence removal
            // Increased duration slightly, reduced threshold for more aggressive removal
            const silenceFilter = "silenceremove=start_periods=1:start_duration=0.3:start_threshold=-40dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-40dB:detection=peak";
            // Using a slightly higher bitrate, standard sample rate, mono
            const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -af "${silenceFilter}" -acodec libmp3lame -ab 64k -ar 44100 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
            console.log('Main: Executing ffmpeg:', ffmpegCommand);
            try {
                await execPromise(ffmpegCommand);
                const mp3Stats = await fs.promises.stat(tempFilePathMp3);
                const convertedSizeBytes = mp3Stats.size;
                if (mp3Stats.size === 0) {
                    console.log("Main: ffmpeg resulted in empty MP3 (likely silence or too short). Skipping transcription.");
                    operationResult = { success: true, error: "Recording contained only silence.", retryable: false, transcriptionText: "" };

                    // Send progress update even for silence
                    if (mainWindow && !mainWindow.isDestroyed()) {
                         console.log("Main: Sending ffmpeg progress update (silence detected).");
                         mainWindow.webContents.send('ffmpeg-progress', {
                             originalSize: originalSizeBytes,
                             convertedSize: 0,
                             originalFormatted: formatBytes(originalSizeBytes),
                             convertedFormatted: formatBytes(0),
                             reductionPercent: originalSizeBytes > 0 ? 100 : 0 // 100% reduction if original had size
                         });
                     } else {
                         console.warn("Main: Cannot send ffmpeg progress, mainWindow is gone.");
                     }

                    // Return early, finally block will handle cleanup and hide
                    return operationResult;
                }
                mp3FileCreated = true;
                console.log(`Main: Converted audio (${formatBytes(convertedSizeBytes)}) saved to ${tempFilePathMp3}`);

                // --- Send progress update to renderer ---
                 if (mainWindow && !mainWindow.isDestroyed()) {
                     const reductionPercent = originalSizeBytes > 0
                        ? Math.round(((originalSizeBytes - convertedSizeBytes) / originalSizeBytes) * 100)
                        : 0;
                     console.log("Main: Sending ffmpeg progress update.");
                     mainWindow.webContents.send('ffmpeg-progress', {
                         originalSize: originalSizeBytes,
                         convertedSize: convertedSizeBytes,
                         originalFormatted: formatBytes(originalSizeBytes),
                         convertedFormatted: formatBytes(convertedSizeBytes),
                         reductionPercent: Math.max(0, reductionPercent) // Ensure non-negative
                     });
                 } else {
                     console.warn("Main: Cannot send ffmpeg progress, mainWindow is gone.");
                 }
                 // --- End progress update ---

            } catch (ffmpegError) {
                console.error('Main: ffmpeg processing failed:', ffmpegError);
                let errorDetail = ffmpegError.message || 'Unknown ffmpeg error';
                if (ffmpegError.stderr) { errorDetail += `\nFFmpeg stderr: ${ffmpegError.stderr}`; }
                 if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                     throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
                 }
                // Check if error indicates input file issue (e.g., corrupted)
                 if (errorDetail.includes('Invalid data found when processing input')) {
                     throw new Error(`ffmpeg failed: Input audio data seems invalid or corrupted.`);
                 }
                throw new Error(`ffmpeg processing failed: ${errorDetail}`);
            }

            // 3. Perform Transcription & Pasting using the helper
            operationResult = await _performTranscriptionAndPasting(tempFilePathMp3);

            return operationResult; // Return result from helper

        } catch (error) { // Catches errors from saving, ffmpeg setup, etc. (before _performTranscriptionAndPasting)
            console.error('Main: Error during pre-transcription process:', error);
            operationResult = { success: false, error