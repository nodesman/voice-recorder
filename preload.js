// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Sends audio data (as Uint8Array) to the main process for transcription & pasting.
     * Returns a Promise that resolves with { success: true } or { success: false, error: '...' }.
     */
    transcribeAndPaste: (audioDataUint8Array) => { // Renamed for clarity
        if (!audioDataUint8Array || !(audioDataUint8Array instanceof Uint8Array)) {
             console.error("Preload: transcribeAndPaste expects a Uint8Array.");
             return Promise.resolve({ success: false, error: "Invalid audio data format sent from renderer." });
        }
        console.log(`Preload: Sending ${audioDataUint8Array.length} bytes to main process via IPC ('transcribe-audio').`);
        // Use invoke for handling asynchronous request/response with main process
        return ipcRenderer.invoke('transcribe-audio', audioDataUint8Array);
    },

    /**
     * Tells the main process to hide the window.
     */
    hideWindow: () => {
        console.log("Preload: Sending hide-window request to main.");
        ipcRenderer.send('hide-window'); // Use send for one-way command
    },

    /**
     * Listens for a trigger from the main process to start recording.
     * @param {function} callback - The function to call when the trigger is received.
     */
    onTriggerStartRecording: (callback) => {
        ipcRenderer.on('trigger-start-recording', (_event) => {
            console.log("Preload: Received trigger-start-recording event.");
            callback();
        });
    },

     /**
      * Listens for a trigger from the main process to stop recording.
      * @param {function} callback - The function to call with the save flag (boolean).
      */
     onTriggerStopRecording: (callback) => {
         ipcRenderer.on('trigger-stop-recording', (_event, shouldSave) => {
             console.log(`Preload: Received trigger-stop-recording event (save: ${shouldSave}).`);
             callback(shouldSave);
         });
     }
});

console.log('Preload script executed. API:', Object.keys(window.electronAPI || {}));