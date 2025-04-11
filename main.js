// main.js
const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron'); // <-- Import globalShortcut & dialog
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables

// --- NEW: Import child_process and promisify exec ---
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
// --- END NEW ---

// --- NEW: Import robotjs ---
let robot = null;
try {
    robot = require('robotjs');
    console.log("Main: robotjs loaded successfully.");
} catch (e) {
    console.error("FATAL ERROR: Failed to load robotjs. Automatic pasting will not work.");
    console.error("Ensure robotjs is installed correctly (npm install robotjs) and build tools are available.");
    // We need to show this error *after* app is ready
    app.on('ready', () => {
        dialog.showErrorBox("Initialization Error", "Failed to load core component (robotjs) required for pasting text. Please check installation and system dependencies. The application will exit.");
        app.quit();
    });
}
// --- END NEW ---

// --- OpenAI Setup ---
const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
    console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
    // Show error after app is ready
    app.on('ready', () => {
        dialog.showErrorBox("Configuration Error", "OpenAI API Key is missing. Please set OPENAI_API_KEY in the .env file. The application will exit.");
        app.quit();
    });
}
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
}) : null; // Initialize only if key exists
// --- END OpenAI Setup ---

let mainWindow = null; // <-- Keep a reference accessible outside createWindow

function createWindow() {
    // Create the browser window but don't show it yet.
    mainWindow = new BrowserWindow({
        width: 380,
        // Adjust height slightly if needed, depends on final UI element sizes
        height: 65, // Reduced height slightly as transcription text box is gone
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        show: false, // <--- Start hidden
        skipTaskbar: true,
        transparent: true,
        // --- NEW: Enable dragging via transparent window (might not be needed with CSS drag region) ---
        // Tabbing focuses elements within the window rather than moving focus away
        acceptFirstMouse: true, // Helps with clicking immediately after showing
        // --- END NEW ---
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: !app.isPackaged,
        }
    });

    mainWindow.loadFile('index.html');

    // Dereference the window object when the window is closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

     // Hide the window when it loses focus
     mainWindow.on('blur', () => {
         if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
              console.log("Window blurred, hiding.");
              // Tell renderer to stop recording if it's active when blurred
              mainWindow.webContents.send('trigger-stop-recording', false); // false = don't save/process (cancel)
              mainWindow.hide();
         }
     });
}

// --- App Lifecycle ---

app.whenReady().then(() => {
    // Exit now if critical components failed to load earlier
    if (!robot || !openai) {
        console.error("Exiting due to initialization errors (robotjs or OpenAI key).");
        // Error dialogs shown via app.on('ready') handlers
        return; // Stop further initialization
    }

    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    createWindow();

    // Register a global shortcut listener.
    const ret = globalShortcut.register('CmdOrCtrl+Shift+R', () => {
        console.log('Shortcut CmdOrCtrl+Shift+R pressed');
        if (mainWindow) {
            if (mainWindow.isVisible() && mainWindow.isFocused()) {
                console.log("Main: Window visible and focused, stopping recording (if active) and hiding.");
                // Tell renderer to stop recording if active, *then* hide
                mainWindow.webContents.send('trigger-stop-recording', true); // true = save and process
                // Hiding will now happen *after* processing in the renderer via hideWindow()
            } else {
                console.log("Main: Window not visible or not focused, showing and triggering record.");
                // Show and focus first
                mainWindow.show();
                mainWindow.focus();
                 // --- NEW: Send message to renderer to start recording ---
                 // Use setTimeout to ensure window is fully visible and focused before triggering
                 setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) { // Extra check
                       console.log("Main: Sending trigger-start-recording to renderer.");
                       mainWindow.webContents.send('trigger-start-recording');
                    } else {
                        console.log("Main: Window closed or hidden before start trigger could be sent.");
                    }
                 }, 100); // Increased delay slightly
                 // --- END NEW ---
            }
        } else {
            console.log("Main: Shortcut triggered but mainWindow is null. Recreating.");
            createWindow(); // Recreate if window was destroyed
             // Show and focus immediately after recreation
             if (mainWindow) {
                 mainWindow.once('ready-to-show', () => { // Wait until loaded
                     mainWindow.show();
                     mainWindow.focus();
                     // Trigger recording after showing
                     setTimeout(() => {
                        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                           console.log("Main: Sending trigger-start-recording to renderer after recreation.");
                           mainWindow.webContents.send('trigger-start-recording');
                        }
                     }, 100);
                 });
             }
        }
    });

    if (!ret) {
        console.error('Main: globalShortcut registration failed');
        dialog.showErrorBox("Error", "Failed to register global shortcut (CmdOrCtrl+Shift+R). Is another application using it?");
        // Optionally quit if shortcut is essential
        // app.quit();
    } else {
        console.log('Main: globalShortcut CmdOrCtrl+Shift+R registered successfully.');
    }

});

// Quit when all windows are closed
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Unregister shortcuts when quitting
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    console.log('Main: Unregistered all global shortcuts.');
});

// --- NEW: IPC Handler to Hide Window from Renderer ---
ipcMain.on('hide-window', () => {
    console.log("Main: Received hide-window request from renderer.");
    if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide();
    }
});
// --- END NEW ---


// --- IPC Handler for Transcription ---
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
    console.log('Main: Received audio data for transcription.');
    // Return status structure: { success: boolean, error?: string }
    let operationStatus = { success: false, error: null };

    // These checks should ideally prevent reaching here if failed, but double-check
    if (!robot) {
         const errorMsg = "robotjs module not loaded. Cannot paste transcription.";
         console.error("Main:", errorMsg);
         // Dialog was shown on startup, just return error status
         operationStatus.error = errorMsg;
         return operationStatus;
    }
    if (!openai) {
        const errorMsg = "OpenAI API key not configured. Cannot transcribe.";
        console.error("Main:", errorMsg);
        // Dialog was shown on startup, just return error status
        operationStatus.error = errorMsg;
        return operationStatus;
    }

    if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
        console.error('Main: No audio data received.');
        operationStatus.error = 'No audio data received by main process.';
        return operationStatus;
    }

    // --- File Paths ---
    const timestamp = Date.now();
    const tempFileNameWebm = `rec-input-${timestamp}.webm`;
    const tempFileNameMp3 = `rec-output-${timestamp}.mp3`;
    const tempFilePathWebm = path.join(os.tmpdir(), tempFileNameWebm);
    const tempFilePathMp3 = path.join(os.tmpdir(), tempFileNameMp3);
    // --- End File Paths ---

    let webmFileWritten = false;
    let mp3FileCreated = false;

    try {
        // 1. Save original buffer to a temporary .webm file
        const nodeBuffer = Buffer.from(audioDataUint8Array);
        if (nodeBuffer.length === 0) {
            throw new Error("Received audio data resulted in an empty Buffer.");
        }
        await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
        webmFileWritten = true;
        console.log(`Main: Original audio saved to ${tempFilePathWebm} (Size: ${nodeBuffer.length} bytes)`);

        // 2. Convert .webm to .mp3 using ffmpeg
        // Use reasonable defaults for Whisper (MP3, mono, 16kHz often good)
        const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -acodec libmp3lame -ab 48k -ar 16000 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
        console.log('Main: Executing ffmpeg:', ffmpegCommand);

        try {
            // Use exec directly for better error capture
            await new Promise((resolve, reject) => {
                exec(ffmpegCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Main: ffmpeg exec error: ${error.message}`);
                        console.error(`Main: ffmpeg stderr: ${stderr}`);
                        reject(new Error(`ffmpeg failed: ${stderr || error.message}`));
                        return;
                    }
                    if (stderr) {
                         console.warn(`Main: ffmpeg stderr output: ${stderr}`);
                    }
                    console.log(`Main: ffmpeg stdout: ${stdout}`);
                    resolve();
                });
            });

             // Check if the output file was actually created and has size
            try {
                 await fs.promises.access(tempFilePathMp3, fs.constants.F_OK);
                 const mp3Stats = await fs.promises.stat(tempFilePathMp3);
                 if (mp3Stats.size === 0) { throw new Error("ffmpeg conversion resulted in an empty MP3 file."); }
                 mp3FileCreated = true;
                 console.log(`Main: Converted audio saved to ${tempFilePathMp3} (Size: ${mp3Stats.size} bytes)`);
            } catch (accessOrStatError) {
                 // This error might follow a successful exec if ffmpeg failed silently but didn't return an error code
                 throw new Error(`ffmpeg command may have run but output file not found or empty: ${tempFilePathMp3}. Error: ${accessOrStatError.message}`);
            }
        } catch (ffmpegError) {
            // Catch errors from exec or the file check
            console.error('Main: ffmpeg processing failed:', ffmpegError);
            const errorDetail = ffmpegError.message || 'Unknown ffmpeg error';
            if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                 throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
            }
            throw new Error(`ffmpeg conversion failed: ${errorDetail}`); // Re-throw the specific error
        }

        // 3. Send *converted* MP3 file to OpenAI Whisper API
        console.log('Main: Sending converted MP3 to OpenAI...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePathMp3),
            model: 'whisper-1', // Use the base model for speed
            // prompt: "User is dictating text." // Optional: Add prompt if needed
            // language: "en" // Optional: Specify language if known
        });

        const transcribedText = transcription.text?.trim();
        console.log('Main: Transcription successful:', transcribedText || "[Empty result]");

        // 4. Paste the text using robotjs
        if (transcribedText && transcribedText.length > 0) {
            try {
                console.log("Main: Pasting text via robotjs...");
                // Ensure the target application has focus. This might require platform-specific handling
                // or user awareness. Pasting happens into the currently focused input field.
                robot.typeString(transcribedText);
                console.log("Main: Pasting finished.");
                operationStatus.success = true; // Mark success *after* pasting
            } catch (robotError) {
                 console.error("Main: robotjs pasting failed:", robotError);
                 // Don't throw here, report error via dialog and return status
                 const pasteErrorMsg = `Transcription succeeded but pasting failed: ${robotError.message}. Please ensure the target window was active.`;
                 dialog.showErrorBox("Pasting Error", pasteErrorMsg);
                 operationStatus.error = pasteErrorMsg; // Set error, but don't overwrite success=false yet
                 // We consider transcription a success, but pasting failed. Let renderer know.
                 // Return success: false as the overall *paste* operation failed.
                 operationStatus.success = false;
            }
        } else {
            console.log("Main: Transcription result was empty or only whitespace, nothing to paste.");
            // Consider this scenario a success (process finished), although nothing was pasted.
            operationStatus.success = true;
        }

        // 5. Return the status
        return operationStatus;

    } catch (error) {
        console.error('Main: Error during transcription/pasting process:', error);
        let errorMessage = 'An unexpected error occurred during processing.';
        if (error instanceof OpenAI.APIError) {
            console.error(`OpenAI API Error: Status=${error.status}, Type=${error.type}, Code=${error.code}, Message=${error.message}`);
            errorMessage = `OpenAI Error (${error.status}): ${error.message || 'Failed to transcribe.'}`;
        } else if (error instanceof Error) {
            // Use the specific error message (e.g., from ffmpeg, file system)
            errorMessage = error.message;
        }
        // --- NEW: Show error dialog ---
        dialog.showErrorBox("Processing Failed", errorMessage);
        // --- END NEW ---
        operationStatus.error = errorMessage; // Set error status
        operationStatus.success = false; // Ensure success is false on error
        return operationStatus; // Return error status

    } finally {
        // 6. Clean up temporary files
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
        console.log("Main: Transcription IPC handler finished.");
    }
});
// --- END IPC Handler ---