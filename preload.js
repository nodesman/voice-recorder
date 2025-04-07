// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose a controlled API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Sends audio data (as Uint8Array) to the main process for transcription.
     * Returns a Promise that resolves with { text: '...' } or { error: '...' }.
     */
    transcribeAudio: (audioDataUint8Array) => {
        if (!audioDataUint8Array || !(audioDataUint8Array instanceof Uint8Array)) {
             console.error("Preload: transcribeAudio expects a Uint8Array.");
             return Promise.resolve({ error: "Invalid audio data format sent from renderer." });
        }
        console.log(`Preload: Sending ${audioDataUint8Array.length} bytes to main process via IPC.`);
        // Use invoke for handling asynchronous request/response with main process
        return ipcRenderer.invoke('transcribe-audio', audioDataUint8Array);
    }
});

console.log('Preload script executed.');