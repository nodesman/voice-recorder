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
        width: 380,
        height: 75,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: !app.isPackaged,
        }
    });

    mainWindow.loadFile('index.html');

    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
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
    const tempFileNameWebm = `openai-audio-input-${timestamp}.webm`;
    const tempFileNameMp3 = `openai-audio-output-${timestamp}.mp3`;
    const tempFilePathWebm = path.join(os.tmpdir(), tempFileNameWebm);
    const tempFilePathMp3 = path.join(os.tmpdir(), tempFileNameMp3);
    // --- End File Paths ---

    let webmFileWritten = false;
    let mp3FileCreated = false;
    let webmFileSize = 0; // Variable to store webm size
    let mp3FileSize = 0;  // Variable to store mp3 size

    try {
        // 1. Save original buffer to a temporary .webm file
        const nodeBuffer = Buffer.from(audioDataUint8Array);
        if (nodeBuffer.length === 0) {
            throw new Error("Received audio data resulted in an empty Buffer.");
        }
        await fs.promises.writeFile(tempFilePathWebm, nodeBuffer);
        webmFileWritten = true;

        // --- Get and log original WebM file size ---
        try {
            const webmStats = await fs.promises.stat(tempFilePathWebm);
            webmFileSize = webmStats.size;
            console.log(`Main: Original audio saved to ${tempFilePathWebm} (Size: ${webmFileSize} bytes)`);
        } catch (statError) {
             console.warn(`Main: Could not get stats for temporary webm file ${tempFilePathWebm}: ${statError.message}`);
             // Don't stop the process, but log the warning
        }
        // --- End WebM size logging ---

        // 2. Convert .webm to .mp3 using ffmpeg
        const ffmpegCommand = `ffmpeg -i "${tempFilePathWebm}" -vn -acodec libmp3lame -ab 64k -y -hide_banner -loglevel error "${tempFilePathMp3}"`;
        console.log('Main: Executing ffmpeg command:', ffmpegCommand);

        try {
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            if (stderr) {
                console.warn('Main: ffmpeg reported warnings/errors:', stderr);
            }
            // ffmpeg stdout is usually empty with -hide_banner -loglevel error, but log if present
            if (stdout) console.log('Main: ffmpeg conversion stdout:', stdout);

            // Check if the output file was actually created and get its size
            try {
                 await fs.promises.access(tempFilePathMp3, fs.constants.F_OK);
                 const mp3Stats = await fs.promises.stat(tempFilePathMp3); // Get stats
                 mp3FileSize = mp3Stats.size; // Store size
                 mp3FileCreated = true;

                 // --- Log MP3 file size and comparison ---
                 console.log(`Main: Converted audio saved to ${tempFilePathMp3} (Size: ${mp3FileSize} bytes)`);
                 if (webmFileSize > 0 && mp3FileSize > 0) {
                    const reductionPercent = ((webmFileSize - mp3FileSize) / webmFileSize * 100).toFixed(1);
                    console.log(`Main: File size reduced by ${reductionPercent}%`);
                 }
                 // --- End MP3 size logging ---

                 if (mp3FileSize === 0) {
                    throw new Error("ffmpeg conversion resulted in an empty MP3 file.");
                 }
            } catch (accessOrStatError) {
                 throw new Error(`ffmpeg command ran but output file not found, inaccessible, or stats failed for: ${tempFilePathMp3}. stderr: ${stderr}. Error: ${accessOrStatError.message}`);
            }

        } catch (ffmpegError) {
            console.error('Main: ffmpeg execution failed:', ffmpegError);
            if (ffmpegError.message.includes('ENOENT') || (ffmpegError.stderr && ffmpegError.stderr.toLowerCase().includes('command not found'))) {
                 throw new Error('ffmpeg command failed. Ensure ffmpeg is installed and in your system PATH.');
            }
            throw new Error(`ffmpeg conversion failed: ${ffmpegError.message || ffmpegError.stderr}`);
        }

        // 3. Send *converted* MP3 file to OpenAI Whisper API
        console.log('Main: Sending converted MP3 audio to OpenAI Whisper API...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePathMp3),
            model: 'whisper-1',
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