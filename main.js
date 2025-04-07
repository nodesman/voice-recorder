// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables

// --- OpenAI Setup ---
const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
    console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
    // In a real app, show an error dialog to the user before quitting
    // Consider using dialog.showErrorBox('Error', 'OpenAI API Key is missing...');
    app.quit();
    process.exit(1); // Ensure exit if app.quit() is asynchronous
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 480, // Adjusted width slightly
        height: 180, // Adjusted height to accommodate text better
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, // Recommended: true
            nodeIntegration: false, // Recommended: false
            devTools: !app.isPackaged, // Enable DevTools only when not packaged
        }
    });

    mainWindow.loadFile('index.html');

    // Open DevTools automatically if not packaged
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    // Quit when all windows are closed, except on macOS.
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handler for Transcription ---
// Listens for 'transcribe-audio' event from the renderer process
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
    console.log('Main: Received audio data for transcription.');

    if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
        console.error('Main: No audio data received or buffer is empty.');
        return { error: 'No audio data received by main process.' };
    }

    // 1. Save buffer to a temporary file (OpenAI SDK prefers files)
    //    Whisper is good with many formats, webm/opus is generally fine.
    const tempFileName = `openai-audio-${Date.now()}.webm`; // Assume webm, adjust if mime type is passed
    const tempFilePath = path.join(os.tmpdir(), tempFileName);
    let fileWritten = false;

    try {
        // Convert the incoming Uint8Array (marshalled by IPC) to a Node.js Buffer
        const nodeBuffer = Buffer.from(audioDataUint8Array);

        if (nodeBuffer.length === 0) {
            throw new Error("Received audio data resulted in an empty Buffer.");
        }

        await fs.promises.writeFile(tempFilePath, nodeBuffer);
        fileWritten = true;
        console.log(`Main: Audio saved temporarily to ${tempFilePath} (${nodeBuffer.length} bytes)`);

        // 2. Send file to OpenAI Whisper API
        console.log('Main: Sending audio to OpenAI Whisper API...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: 'whisper-1', // Or another Whisper model if needed
            // language: "en", // Optional: Specify language ISO-639-1 code
            // prompt: "...", // Optional: Guide the model with expected phrases/context
        });

        console.log('Main: Transcription successful:', transcription.text);

        // 3. Return the result (cleanup happens in finally)
        return { text: transcription.text };

    } catch (error) {
        console.error('Main: Error during transcription process:', error);
        // Attempt to parse OpenAI specific errors if available
        let errorMessage = 'Unknown transcription error occurred.';
        if (error instanceof OpenAI.APIError) {
            // Log more details for OpenAI errors
            console.error(`OpenAI API Error Details: Status=${error.status}, Type=${error.type}, Code=${error.code}`);
            errorMessage = `OpenAI Error (${error.status}): ${error.message}`;
        } else if (error instanceof Error) {
            errorMessage = error.message; // Standard JS error
        }
        return { error: errorMessage };

    } finally {
        // 4. Clean up the temporary file if it was written
        if (fileWritten) {
            try {
                await fs.promises.unlink(tempFilePath);
                console.log(`Main: Deleted temporary file ${tempFilePath}`);
            } catch (unlinkErr) {
                // Log deletion error but don't prevent response from being sent
                console.error(`Main: Failed to delete temporary file ${tempFilePath}:`, unlinkErr);
            }
        }
    }
});