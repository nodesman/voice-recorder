// main.js
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables

// --- OpenAI Setup ---
const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
    console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
    app.on('ready', () => {
        dialog.showErrorBox("Configuration Error", "OpenAI API Key is missing. Please set OPENAI_API_KEY in the .env file. The application will exit.");
        app.quit();
    });
}
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
}) : null;
// --- END OpenAI Setup ---


let mainWindow = null;

function createWindow() {
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
        alwaysOnTop: true, // Keep this TRUE
        show: false,
        skipTaskbar: true,
        transparent: true,
        acceptFirstMouse: true, // Allows clicking buttons even if inactive
        focusable: false, // *** ADDED: Prevents window from becoming focusable ***
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

    // --- REMOVED/COMMENTED OUT the 'blur' listener ---
    /*
    mainWindow.on('blur', () => {
        // This logic is removed because we WANT the window to stay open
        // and potentially continue recording even when blurred.
        // Stopping/hiding is now handled explicitly by the user action
        // (shortcut again, or confirm/cancel buttons).
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
             console.log("Window blurred, but taking NO automatic action.");
            // mainWindow.webContents.send('trigger-stop-recording', false); // NO LONGER CANCEL ON BLUR
            // mainWindow.hide(); // NO LONGER HIDE ON BLUR
        }
    });
    */
}

// --- App Lifecycle ---

app.whenReady().then(() => {
    if (!openai) {
        console.error("Exiting due to missing OpenAI key.");
        return;
    }

    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    createWindow();

    const ret = globalShortcut.register('CmdOrCtrl+Shift+R', () => {
        console.log('Shortcut CmdOrCtrl+Shift+R pressed');
        if (mainWindow) {
            // Check if window is visible AND if recording is *active* in the renderer
            // We need a way to know the renderer's state, but main doesn't know directly.
            // Let's simplify: If the window is visible, the shortcut means STOP.
            // If the window is hidden, the shortcut means START.
            if (mainWindow.isVisible()) {
                console.log("Main: Window visible, assuming stop recording & process.");
                // Tell renderer to stop recording and process
                mainWindow.webContents.send('trigger-stop-recording', true); // true = save and process
                // Hiding will happen in the renderer *after* processing is complete or on cancel.
            } else {
                console.log("Main: Window not visible, showing inactive and triggering record.");
                // *** CHANGED: Use showInactive() and remove focus() ***
                mainWindow.showInactive(); // Show without activating/focusing
                // mainWindow.focus(); // <-- REMOVED
                 setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                       console.log("Main: Sending trigger-start-recording to renderer.");
                       mainWindow.webContents.send('trigger-start-recording');
                    } else {
                        console.log("Main: Window closed or hidden before start trigger could be sent.");
                    }
                 }, 100); // Keep slight delay
            }
        } else {
            console.log("Main: Shortcut triggered but mainWindow is null. Recreating.");
            createWindow();
             if (mainWindow) {
                 mainWindow.once('ready-to-show', () => {
                     // *** CHANGED: Use showInactive() and remove focus() ***
                     mainWindow.showInactive(); // Show without activating/focusing
                     // mainWindow.focus(); // <-- REMOVED
                     setTimeout(() => {
                        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                           console.log("Main: Sending trigger-start-recording to renderer after recreation.");
                           mainWindow.webContents.send('trigger-start-recording');
                        }
                     }, 100); // Keep slight delay
                 });
             }
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
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    console.log('Main: Unregistered all global shortcuts.');
});

ipcMain.on('hide-window', () => {
    console.log("Main: Received hide-window request from renderer.");
    if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide();
    }
});

// --- IPC Handler for Transcription & Copying ---
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => { // Kept same channel name
    console.log('Main: Received audio data for transcription and copying.');
    let operationStatus = { success: false, error: null };

    // --- REMOVED: robotjs check ---
    if (!openai) {
        const errorMsg = "OpenAI API key not configured. Cannot transcribe.";
        console.error("Main:", errorMsg);
        operationStatus.error = errorMsg;
        return operationStatus; // Return error status
    }

    if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
        console.error('Main: No audio data received.');
        operationStatus.error = 'No audio data received by main process.';
        return operationStatus;
    }

    const timestamp = Date.now();
    const tempFileNameWebm = `rec-input-${timestamp}.webm`;
    const tempFileNameMp3 = `rec-output-${timestamp}.mp3`; // Changed target format
    const tempFilePathWebm = path.join(os.tmpdir(), tempFileNameWebm);
    const tempFilePathMp3 = path.join(os.tmpdir(), tempFileNameMp3); // Changed path

    let webmFileWritten = false;
    let mp3FileCreated = false; // Track the mp3 file

    try {
        // 1. Save original buffer
        const nodeBuffer = Buffer.from(audioDataUint8Array);
        if (nodeBuffer.length === 0) {
            throw new Error("Received audio data resulted in an empty Buffer.");
        }
        await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
        webmFileWritten = true;
        console.log(`Main: Original audio saved to ${tempFilePathWebm} (Size: ${nodeBuffer.length} bytes)`);

        // 2. Convert .webm to .mp3 using ffmpeg (Requires ffmpeg in PATH)
        const { exec } = require('child_process'); // Keep exec require scoped here or move to top
        const util = require('util'); // Keep util require scoped here or move to top

        const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -acodec libmp3lame -ab 48k -ar 16000 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
        console.log('Main: Executing ffmpeg:', ffmpegCommand);
        try {
           await new Promise((resolve, reject) => {
                exec(ffmpegCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Main: ffmpeg exec error: ${error.message}`);
                        console.error(`Main: ffmpeg stderr: ${stderr}`);
                        reject(new Error(`ffmpeg failed: ${stderr || error.message}`));
                        return;
                    }
                     if (stderr && !stderr.includes('Output file is empty')) { // Ignore specific harmless stderr messages if needed
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
                 throw new Error(`ffmpeg command may have run but output file not found or empty: ${tempFilePathMp3}. Error: ${accessOrStatError.message}`);
            }
        } catch (ffmpegError) {
             console.error('Main: ffmpeg processing failed:', ffmpegError);
             const errorDetail = ffmpegError.message || 'Unknown ffmpeg error';
             if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                  throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
             }
             throw new Error(`ffmpeg conversion failed: ${errorDetail}`);
        }

        // 3. Send *converted* MP3 file to OpenAI
        console.log('Main: Sending converted MP3 to OpenAI...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePathMp3), // Use MP3 path
            model: 'whisper-1',
        });

        const transcribedText = transcription.text?.trim();
        console.log('Main: Transcription successful:', transcribedText || "[Empty result]");

        // 4. Copy the text to clipboard using Electron's clipboard module
        if (transcribedText && transcribedText.length > 0) {
            try {
                console.log("Main: Copying text to clipboard...");
                clipboard.writeText(transcribedText); // <-- Use clipboard API
                console.log("Main: Copying finished.");
                operationStatus.success = true; // Mark success *after* copying
            } catch (copyError) {
                 console.error("Main: Clipboard write failed:", copyError);
                 const copyErrorMsg = `Transcription succeeded but copying failed: ${copyError.message}.`;
                 dialog.showErrorBox("Copying Error", copyErrorMsg); // Inform user
                 operationStatus.error = copyErrorMsg;
                 operationStatus.success = false; // Copy failed
            }
        } else {
            console.log("Main: Transcription result was empty, nothing to copy.");
            operationStatus.success = true; // Process finished successfully, even if nothing copied
        }

        // 5. Return the status (Renderer will handle hiding window)
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
        dialog.showErrorBox("Processing Failed", errorMessage); // Show error dialog
        operationStatus.error = errorMessage;
        operationStatus.success = false;
        return operationStatus; // Return error status

    } finally {
        // 6. Clean up temporary files
        if (webmFileWritten) {
            fs.promises.unlink(tempFilePathWebm)
                .then(() => console.log(`Main: Deleted temp webm file ${tempFilePathWebm}`))
                .catch(err => console.error(`Main: Failed to delete temp webm file ${tempFilePathWebm}:`, err));
        }
        if (mp3FileCreated) { // Cleanup mp3 file
            fs.promises.unlink(tempFilePathMp3)
                .then(() => console.log(`Main: Deleted temp mp3 file ${tempFilePathMp3}`))
                .catch(err => console.error(`Main: Failed to delete temp mp3 file ${tempFilePathMp3}:`, err));
        }
        console.log("Main: Transcription IPC handler finished.");
    }
});
// --- END IPC Handler ---