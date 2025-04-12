// main.js
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables
const { exec } = require('child_process'); // Moved exec require to top for clarity
const util = require('util');             // Moved util require to top for clarity
const execPromise = util.promisify(exec); // Create a promisified version of exec

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
let isProcessingShortcut = false; // <-- ADD THIS FLAG

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
    mainWindow.on('blur', () => { ... }); // Keep this commented out
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

    createWindow(); // Create initial window

    const ret = globalShortcut.register('CmdOrCtrl+Shift+R', () => {
        console.log('Shortcut CmdOrCtrl+Shift+R pressed');

        // --- ADD LOCK CHECK ---
        if (isProcessingShortcut) {
            console.log('Main: Shortcut handling already in progress. Skipping.');
            return;
        }
        // --- SET LOCK ---
        isProcessingShortcut = true;
        console.log('Main: Acquired shortcut lock.');

        // Use a try...catch block to ensure the lock is released
        try {
            if (mainWindow) {
                if (mainWindow.isDestroyed()) { // Handle case where window was closed unexpectedly
                    console.log("Main: mainWindow was destroyed. Recreating.");
                    mainWindow = null; // Reset mainWindow
                    createWindow();
                    // Set up window to show and start recording once ready
                    if (mainWindow) {
                        mainWindow.once('ready-to-show', () => {
                            mainWindow.showInactive();
                            setTimeout(() => {
                                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                                    console.log("Main: Sending trigger-start-recording after recreation.");
                                    mainWindow.webContents.send('trigger-start-recording');
                                }
                                // Release lock AFTER async operation completes
                                isProcessingShortcut = false;
                                console.log('Main: Released shortcut lock (after recreate/start timer).');
                            }, 100);
                        });
                    } else {
                        // If creation failed immediately, release lock
                         isProcessingShortcut = false;
                         console.log('Main: Released shortcut lock (createWindow failed).');
                    }
                } else if (mainWindow.isVisible()) {
                    console.log("Main: Window visible, assuming stop recording & process.");
                    mainWindow.webContents.send('trigger-stop-recording', true); // true = save and process
                    // Release lock immediately after sending stop command
                    isProcessingShortcut = false;
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
                        // Release lock AFTER async operation completes
                        isProcessingShortcut = false;
                        console.log('Main: Released shortcut lock (after show/start timer).');
                    }, 100); // Keep slight delay
                }
            } else {
                // This case handles if the app is running but the window was closed
                console.log("Main: Shortcut triggered but mainWindow is null. Recreating.");
                createWindow();
                 if (mainWindow) {
                     mainWindow.once('ready-to-show', () => {
                         mainWindow.showInactive();
                         setTimeout(() => {
                            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                               console.log("Main: Sending trigger-start-recording to renderer after recreation.");
                               mainWindow.webContents.send('trigger-start-recording');
                            }
                             // Release lock AFTER async operation completes
                            isProcessingShortcut = false;
                            console.log('Main: Released shortcut lock (after recreate/start timer - null path).');
                         }, 100);
                     });
                 } else {
                    // If creation failed immediately, release lock
                    isProcessingShortcut = false;
                    console.log('Main: Released shortcut lock (createWindow failed - null path).');
                 }
            }
        } catch (error) {
            console.error("Main: Error during shortcut handling:", error);
            // --- ENSURE LOCK RELEASE ON ERROR ---
            isProcessingShortcut = false;
            console.log('Main: Released shortcut lock due to error.');
        }
        // --- REMOVE IMMEDIATE LOCK RELEASE HERE ---
        // isProcessingShortcut = false; // <-- Remove this immediate release
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
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) { // Added !isDestroyed check
        mainWindow.hide();
    }
});

// --- IPC Handler for Transcription & Copying ---
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
    console.log('Main: Received audio data for transcription and copying.');
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
        //    -af "silenceremove=...": Adds the audio filter for silence removal.
        //      - start_periods=1: Removes silence from the beginning.
        //      - start_duration=0.5: Silence must be at least 0.5 seconds long to be removed at the start.
        //      - start_threshold=-35dB: Audio below -35dB is considered silence (adjust as needed).
        //      - stop_periods=-1: Removes *all* periods of silence from the end meeting criteria.
        //      - stop_duration=0.5: Silence must be at least 0.5 seconds long to be removed at the end.
        //      - stop_threshold=-35dB: Same threshold for the end.
        //      - detection=peak: Use peak volume detection (often better for voice).
        //    Other options:
        //      -vn: No video output.
        //      -acodec libmp3lame: Encode audio to MP3.
        //      -ab 48k: Audio bitrate (adjust for quality vs size tradeoff).
        //      -ar 16000: Audio sample rate (Whisper prefers 16kHz).
        //      -ac 1: Mono audio channel.
        //      -y: Overwrite output file without asking.
        //      -hide_banner -loglevel error: Reduce console noise from ffmpeg.
        const silenceFilter = "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-35dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-35dB:detection=peak";
        const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -af "${silenceFilter}" -acodec libmp3lame -ab 48k -ar 16000 -ac 1 -y -hide_banner -loglevel error "${tempFilePathMp3}"`;

        console.log('Main: Executing ffmpeg with silence removal:', ffmpegCommand);
        try {
            // Use the promisified exec for cleaner async/await
            const { stdout, stderr } = await execPromise(ffmpegCommand);

            if (stderr && !stderr.includes('Output file is empty')) { // Ignore specific harmless stderr messages if needed
                console.warn(`Main: ffmpeg stderr output: ${stderr}`);
           } else if (stderr) {
                console.log(`Main: ffmpeg stderr contained 'Output file is empty' (may be expected if silence removed everything).`);
           }
           if (stdout) {
                console.log(`Main: ffmpeg stdout: ${stdout}`);
           }

            // Check if the output file was actually created and has size
            try {
                 await fs.promises.access(tempFilePathMp3, fs.constants.F_OK);
                 const mp3Stats = await fs.promises.stat(tempFilePathMp3);
                 if (mp3Stats.size === 0) {
                     // Silence removal might result in an empty file if the input was entirely silent
                     // or below the threshold. Treat this as a non-error, but don't proceed.
                     console.log("Main: ffmpeg conversion resulted in an empty MP3 file (likely due to silence removal). Skipping transcription.");
                     operationStatus.success = true; // Indicate success (no error), but nothing was transcribed/copied
                     operationStatus.error = "Recording contained only silence or was too quiet after trimming."; // Optional info message
                     // Clean up and return immediately
                     if (webmFileWritten) await fs.promises.unlink(tempFilePathWebm).catch(e => console.error("Cleanup Error:", e));
                     // mp3 file might exist but is empty, delete it too
                     try { await fs.promises.unlink(tempFilePathMp3); } catch(e) { console.warn("Cleanup Warning: Could not delete empty mp3.", e.message); }
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
             // Include stderr in the error message if available, as it's often helpful
             if (ffmpegError.stderr) {
                errorDetail += `\nFFmpeg stderr: ${ffmpegError.stderr}`;
             }
             if (errorDetail.toLowerCase().includes('command not found') || errorDetail.includes('enoent')) {
                  throw new Error('ffmpeg command not found. Ensure ffmpeg is installed and in your system PATH.');
             }
             throw new Error(`ffmpeg processing failed: ${errorDetail}`);
        }

        // 3. Send *converted and trimmed* MP3 file to OpenAI
        console.log('Main: Sending trimmed MP3 to OpenAI...');
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
                clipboard.writeText(transcribedText);
                console.log("Main: Copying finished.");
                operationStatus.success = true; // Mark success *after* copying
            } catch (copyError) {
                 console.error("Main: Clipboard write failed:", copyError);
                 const copyErrorMsg = `Transcription succeeded but copying failed: ${copyError.message}.`;
                 dialog.showErrorBox("Copying Error", copyErrorMsg);
                 operationStatus.error = copyErrorMsg;
                 operationStatus.success = false;
            }
        } else {
            console.log("Main: Transcription result was empty, nothing to copy.");
            operationStatus.success = true; // Process finished successfully, even if nothing copied
        }

        // 5. Return the status
        return operationStatus;

    } catch (error) {
        console.error('Main: Error during transcription/copying process:', error);
        let errorMessage = 'An unexpected error occurred during processing.';
        if (error instanceof OpenAI.APIError) {
            console.error(`OpenAI API Error: Status=${error.status}, Type=${error.type}, Code=${error.code}, Message=${error.message}`);
            errorMessage = `OpenAI Error (${error.status}): ${error.message || 'Failed to transcribe.'}`;
        } else if (error instanceof Error) {
            errorMessage = error.message; // Use the specific error message (e.g., from ffmpeg or file access)
        }
        // Avoid showing the "silence" message as a blocking error dialog
        if (errorMessage !== "Recording contained only silence or was too quiet after trimming.") {
           dialog.showErrorBox("Processing Failed", errorMessage);
        }
        operationStatus.error = errorMessage;
        operationStatus.success = false;
        return operationStatus;

    } finally {
        // 6. Clean up temporary files
        if (webmFileWritten) {
            fs.promises.unlink(tempFilePathWebm)
                .then(() => console.log(`Main: Deleted temp webm file ${tempFilePathWebm}`))
                .catch(err => console.error(`Main: Failed to delete temp webm file ${tempFilePathWebm}:`, err));
        }
        if (mp3FileCreated) { // Only attempt delete if we know it was created successfully (and wasn't empty due to silence)
            fs.promises.unlink(tempFilePathMp3)
                .then(() => console.log(`Main: Deleted temp mp3 file ${tempFilePathMp3}`))
                .catch(err => console.error(`Main: Failed to delete temp mp3 file ${tempFilePathMp3}:`, err));
        }
        console.log("Main: Transcription IPC handler finished.");
    }
});
// --- END IPC Handler ---