// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config(); // Load .env variables

// --- NEW: Import child_process and promisify exec ---
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
// --- END NEW ---

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
ipcMain.handle('transcribe-audio', async (event, audioDataUint8Array) => {
    console.log('Main: Received audio data for transcription.');

    if (!audioDataUint8Array || audioDataUint8Array.length === 0) {
        console.error('Main: No audio data received or buffer is empty.');
        return { error: 'No audio data received by main process.' };
    }

    // --- File Paths ---
    const timestamp = Date.now();
    const tempFileNameWebm = `openai-audio-input-${timestamp}.webm`; // Original input
    const tempFileNameMp3 = `openai-audio-output-${timestamp}.mp3`;   // Converted output
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
        console.log(`Main: Original audio saved temporarily to ${tempFilePathWebm} (${nodeBuffer.length} bytes)`);

        // 2. Convert .webm to .mp3 using ffmpeg
        //    -i: input file
        //    -vn: disable video recording
        //    -acodec libmp3lame: specify mp3 codec
        //    -ab 64k: set audio bitrate to 64kbps (good balance for voice)
        //    -y: overwrite output file if it exists
        //    -hide_banner -loglevel error: suppress verbose output, show only errors
        //    Quoting paths ("${...}") handles spaces in file paths/names.
        const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -acodec libmp3lame -ab 64k -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
        console.log('Main: Executing ffmpeg command:', ffmpegCommand);

        try {
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            if (stderr) {
                console.warn('Main: ffmpeg reported warnings/errors:', stderr);
                // Depending on the error, you might want to throw or continue
                // For now, we'll try to proceed if the output file exists.
            }
            console.log('Main: ffmpeg conversion stdout:', stdout);

            // Check if the output file was actually created
            try {
                 await fs.promises.access(tempFilePathMp3, fs.constants.F_OK);
                 mp3FileCreated = true;
                 const stats = await fs.promises.stat(tempFilePathMp3);
                 console.log(`Main: Converted audio saved to ${tempFilePathMp3} (${stats.size} bytes)`);
                 if (stats.size === 0) {
                    throw new Error("ffmpeg conversion resulted in an empty MP3 file.");
                 }
            } catch (accessError) {
                 throw new Error(`ffmpeg command ran but output file not found or inaccessible: ${tempFilePathMp3}. stderr: ${stderr}`);
            }

        } catch (ffmpegError) {
            console.error('Main: ffmpeg execution failed:', ffmpegError);
            // Provide a more helpful error if ffmpeg is likely not installed
            if (ffmpegError.message.includes('ENOENT') || (ffmpegError.stderr && ffmpegError.stderr.toLowerCase().includes('command not found'))) {
                 throw new Error('ffmpeg command failed. Ensure ffmpeg is installed and in your system PATH.');
            }
            throw new Error(`ffmpeg conversion failed: ${ffmpegError.message || ffmpegError.stderr}`);
        }

        // 3. Send *converted* MP3 file to OpenAI Whisper API
        console.log('Main: Sending converted MP3 audio to OpenAI Whisper API...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePathMp3), // Use the MP3 file
            model: 'whisper-1',
            // Optionally specify response format if needed, though text is default
            // response_format: "json" // or "text", "srt", "verbose_json", "vtt"
        });

        console.log('Main: Transcription successful:', transcription.text);

        // 4. Return the result
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
        // 5. Clean up BOTH temporary files
        if (webmFileWritten) {
            try {
                await fs.promises.unlink(tempFilePathWebm);
                console.log(`Main: Deleted temporary webm file ${tempFilePathWebm}`);
            } catch (unlinkErr) {
                console.error(`Main: Failed to delete temporary webm file ${tempFilePathWebm}:`, unlinkErr);
            }
        }
         if (mp3FileCreated) {
            try {
                await fs.promises.unlink(tempFilePathMp3);
                console.log(`Main: Deleted temporary mp3 file ${tempFilePathMp3}`);
            } catch (unlinkErr) {
                console.error(`Main: Failed to delete temporary mp3 file ${tempFilePathMp3}:`, unlinkErr);
            }
        }
    }
});
// --- END IPC Handler ---