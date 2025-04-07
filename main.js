// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables

// --- OpenAI Setup ---
// ... (keep existing OpenAI setup code) ...
const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
    console.error("FATAL ERROR: OPENAI_API_KEY not found in .env file.");
    app.quit();
    process.exit(1);
}
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
// --- END OpenAI Setup ---


function createWindow() {
    const mainWindow = new BrowserWindow({
        // --- Dictation Mode Window Settings ---
        width: 380,              // Reduced width
        height: 75,              // Reduced height (enough for bar + transcription text above)
        frame: false,            // Remove window frame (title bar, etc.)
        resizable: false,        // Prevent resizing
        alwaysOnTop: true,       // Keep it above other windows (optional, but common for widgets)
        // --- End Dictation Mode Settings ---
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: !app.isPackaged, // Keep this for development debugging
        }
    });

    mainWindow.loadFile('index.html');

    // Open DevTools automatically if not packaged (Keep this for development!)
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Optional: If you want the window to be draggable even without a frame
    // You'd need to add a CSS class like 'draggable-area' to an element in index.html (e.g., the main bar)
    // and uncomment the line below in style.css
    // mainWindow.webContents.on('dom-ready', () => {
    //     mainWindow.webContents.insertCSS('-webkit-app-region: drag; -webkit-user-select: none;');
    // });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handler for Transcription ---
// ... (keep existing IPC handler code) ...
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
    // ... (no changes needed here) ...
    console.log('Main: Received audio data for transcription.');

    if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
        console.error('Main: No audio data received or buffer is empty.');
        return { error: 'No audio data received by main process.' };
    }

    // 1. Save buffer to a temporary file (OpenAI SDK prefers files)
    const tempFileName = `openai-audio-${Date.now()}.webm`; // Assume webm
    const tempFilePath = path.join(os.tmpdir(), tempFileName);
    let fileWritten = false;

    try {
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
            model: 'whisper-1',
        });

        console.log('Main: Transcription successful:', transcription.text);

        // 3. Return the result
        return { text: transcription.text };

    } catch (error) {
        console.error('Main: Error during transcription process:', error);
        let errorMessage = 'Unknown transcription error occurred.';
        if (error instanceof OpenAI.APIError) {
            console.error(`OpenAI API Error Details: Status=${error.status}, Type=${error.type}, Code=${error.code}`);
            errorMessage = `OpenAI Error (${error.status}): ${error.message}`;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { error: errorMessage };

    } finally {
        // 4. Clean up the temporary file
        if (fileWritten) {
            try {
                await fs.promises.unlink(tempFilePath);
                console.log(`Main: Deleted temporary file ${tempFilePath}`);
            } catch (unlinkErr) {
                console.error(`Main: Failed to delete temporary file ${tempFilePath}:`, unlinkErr);
            }
        }
    }
});
// --- END IPC Handler ---