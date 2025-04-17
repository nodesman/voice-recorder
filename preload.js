// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Sends audio data (as Uint8Array) to the main process for transcription & copying.
     * Returns a Promise that resolves with { success: true } or { success: false, error: '...', retryable?: boolean }.
     */
    transcribeAndCopy: (audioDataUint8Array) => { // Renamed function
        if (!audioDataUint8Array || !(audioDataUint8Array instanceof Uint8Array)) {
             console.error("Preload: transcribeAndCopy expects a Uint8Array.");
             return Promise.resolve({ success: false, error: "Invalid audio data format sent from renderer." });
        }
        console.log(`Preload: Sending ${audioDataUint8Array.length} bytes to main process via IPC ('transcribe-audio').`);
        // Use invoke for handling asynchronous request/response with main process
        // Note: Channel name 'transcribe-audio' kept for simplicity, but could be renamed too.
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
     * Tells the main process to attempt transcription again using the previously failed audio file.
     * Returns a Promise resolving with the result: { success: true } or { success: false, error: '...', retryable?: boolean }.
     */
    retryTranscription: () => {
        console.log("Preload: Sending retry-transcription request to main.");
        return ipcRenderer.invoke('retry-transcription'); // Use invoke for response
    },

    /**
     * Tells the main process to cancel the pending retry (delete temp file, hide window).
     */
    cancelRetry: () => {
        console.log("Preload: Sending cancel-retry request to main.");
        ipcRenderer.send('cancel-retry'); // Use send for one-way command
    },


    /**
     * Listens for a trigger from the main process to start recording.
     * @param {function} callback - The function to call when the trigger is received.
     * @returns {function} A function to remove the listener.
     */
    onTriggerStartRecording: (callback) => {
        const handler = (_event) => {
             console.log("Preload: Received trigger-start-recording event.");
             callback();
         };
        ipcRenderer.on('trigger-start-recording', handler);
        // Return a cleanup function
        return () => ipcRenderer.removeListener('trigger-start-recording', handler);
    },

     /**
      * Listens for a trigger from the main process to stop recording.
      * @param {function} callback - The function to call with the save flag (boolean).
      * @returns {function} A function to remove the listener.
      */
     onTriggerStopRecording: (callback) => {
         const handler = (_event, shouldSave) => {
             console.log(`Preload: Received trigger-stop-recording event (save: ${shouldSave}).`);
             callback(shouldSave);
         };
         ipcRenderer.on('trigger-stop-recording', handler);
         // Return a cleanup function
         return () => ipcRenderer.removeListener('trigger-stop-recording', handler);
     }
});

console.log('Preload script executed. API:', Object.keys(window.electronAPI || {}));