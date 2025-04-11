// renderer.js
"use strict";

// Check essential APIs
if (typeof window.electronAPI?.transcribeAndCopy !== 'function' || // <-- Check for renamed function
    typeof window.electronAPI?.hideWindow !== 'function' ||
    typeof window.electronAPI?.onTriggerStartRecording !== 'function' ||
    typeof window.electronAPI?.onTriggerStopRecording !== 'function') {
    console.error("Electron API functions missing! Check preload script, contextIsolation, and main process IPC handlers.");
    alert("Critical Error: Cannot communicate with the main process correctly. Functionality may be broken. Please check logs or restart.");
    const micButton = document.getElementById('micButton');
    if (micButton) {
        micButton.disabled = true;
        micButton.style.cursor = 'not-allowed';
        micButton.style.fill = '#666';
    }
}

const AudioRecorder = (() => {
    // --- DOM Elements ---
    let recorderContainer;
    let micButton;
    let cancelButton;
    let confirmButton;
    let recordingCanvas;
    let timerDisplay;
    // No need for processingCanvas, spinner is in its own div

    // --- Audio & State Variables ---
    let isRecording = false; // Reflects if mediaRecorder is active
    let currentState = 'idle'; // Track current UI state explicitly
    let mediaStream = null;
    let mediaRecorder = null;
    let audioContext = null;
    let analyserNode = null;
    let sourceNode = null;
    let recordedChunks = [];
    let recordingStartTime;
    let timerIntervalId = null;
    let animationFrameId = null;

    const WAVEFORM_BAR_COUNT = 60;
    let waveformHistory = new Array(WAVEFORM_BAR_COUNT).fill(0);
    let currentMimeType = '';

    // --- Initialization ---
    function init() {
        recorderContainer = document.querySelector('.audio-recorder');
        micButton = document.getElementById('micButton');
        cancelButton = document.getElementById('cancelButton');
        confirmButton = document.getElementById('confirmButton');
        recordingCanvas = document.getElementById('recordingWaveformCanvas');
        timerDisplay = document.getElementById('timerDisplay');

        if (!recorderContainer || !micButton || !cancelButton || !confirmButton || !recordingCanvas || !timerDisplay) {
            console.error("Recorder UI elements not found! Check IDs in index.html.");
            return;
        }

        // Check again if API is available before adding listeners
        if (typeof window.electronAPI?.transcribeAndCopy === 'function' && // <-- Check renamed
            typeof window.electronAPI?.hideWindow === 'function' &&
            typeof window.electronAPI?.onTriggerStartRecording === 'function' &&
            typeof window.electronAPI?.onTriggerStopRecording === 'function') {

            micButton.addEventListener('click', startRecording);
            cancelButton.addEventListener('click', () => stopRecording(false)); // Save=false
            confirmButton.addEventListener('click', () => stopRecording(true)); // Save=true

            // Listen for triggers from main process
            window.electronAPI.onTriggerStartRecording(handleTriggerStart);
            window.electronAPI.onTriggerStopRecording(handleTriggerStop);

            console.log("Audio Recorder Initialized and listeners added.");
        } else {
            console.error("Initialization skipped: Essential electronAPI functions not available.");
             recorderContainer.style.opacity = '0.5';
             recorderContainer.title = 'Recorder disabled due to internal error.';
        }

        // Set initial state based on HTML attribute
        setState(recorderContainer.dataset.state || 'idle');
    }

    // --- State Management ---
    function setState(newState) {
        if (!recorderContainer) return;
        console.log(`State changing from ${currentState} to ${newState}`);
        currentState = newState;
        recorderContainer.dataset.state = newState;
        isRecording = (newState === 'recording'); // Keep isRecording flag sync'd
    }

    // --- Recording Logic ---
    async function startRecording() {
        if (currentState !== 'idle' || typeof window.electronAPI?.transcribeAndCopy !== 'function') { // <-- Check renamed
            console.warn(`Cannot start recording. Current state: ${currentState} or core API unavailable.`);
            return;
        }
        console.log("Attempting to start recording...");
        setState('starting'); // Intermediate state (optional)

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("Microphone access granted.");

            waveformHistory.fill(0);
            recordedChunks = [];
            if (timerIntervalId) clearInterval(timerIntervalId);
            if (animationFrameId) cancelAnimationFrame(animationFrameId);

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            sourceNode = audioContext.createMediaStreamSource(mediaStream);
            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 256;
            analyserNode.smoothingTimeConstant = 0.6;
            sourceNode.connect(analyserNode);

            const mimeTypes = [
                'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4',
            ];
            currentMimeType = '';
            for (const type of mimeTypes) {
                if (MediaRecorder.isTypeSupported(type)) {
                    currentMimeType = type;
                    break;
                }
            }
            console.log("Using MIME type:", currentMimeType || "Browser default");
            const options = currentMimeType ? { mimeType: currentMimeType } : {};
            mediaRecorder = new MediaRecorder(mediaStream, options);

            mediaRecorder.ondataavailable = handleDataAvailable;
            mediaRecorder.onstop = handleStop; // handleStop now manages processing state and hiding
            mediaRecorder.onerror = (event) => { // Add basic error handling
                console.error("MediaRecorder error:", event.error);
                alert(`Recording error: ${event.error.name} - ${event.error.message}`);
                stopRecording(false); // Cancel on error
            };

            mediaRecorder.start(100); // Start collecting data
            recordingStartTime = Date.now();
            setState('recording'); // Transition to recording state visually
            startTimer();
            visualize();

            console.log("Recording started. State:", mediaRecorder.state, "MIME:", mediaRecorder.mimeType);

        } catch (err) {
            console.error("Error starting recording:", err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                 alert("Microphone access was denied. Please allow microphone access in your browser/system settings and try again.");
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                 alert("No microphone found. Please ensure a microphone is connected and enabled.");
            } else {
                 alert(`Could not start recording: ${err.message}`);
            }
            cleanUpAudio();
            setState('idle'); // Revert to idle on failure
        }
    }

    function stopRecording(shouldSaveAndProcess) {
        console.log(`Stopping recording. Save intent: ${shouldSaveAndProcess}. Current state: ${currentState}`);
        if (!isRecording || !mediaRecorder || mediaRecorder.state === 'inactive') {
            console.log("Recorder not active or already stopped.");
            // If somehow in a non-idle state but recorder inactive, force cleanup and idle
            if (currentState !== 'idle') {
                 console.warn("Stop requested while recorder inactive but UI state not idle. Resetting.");
                 cleanUpAudio();
                 setState('idle');
                 // If cancelled, ensure window hides
                 if (!shouldSaveAndProcess && typeof window.electronAPI?.hideWindow === 'function') {
                     window.electronAPI.hideWindow();
                 }
            }
            return;
        }

        // Stop visual feedback immediately
        stopVisualization();
        stopTimer();

        // Attach the save flag to the recorder instance for handleStop to access
        mediaRecorder.shouldSaveAndProcess = shouldSaveAndProcess;

        // If we intend to process, transition to processing state NOW
        if (shouldSaveAndProcess) {
            setState('processing');
        } else {
             // If cancelling, we'll go directly to idle in handleStop/cleanup
             // But setting it here might prevent race conditions? Let handleStop manage final state.
             // setState('idle'); // Maybe defer this
        }

        // Request stop. handleStop will execute asynchronously.
        try {
            mediaRecorder.stop();
            console.log("MediaRecorder stop requested.");
        } catch (error) {
            console.error("Error calling mediaRecorder.stop():", error);
            // Force cleanup and idle state if stopping fails catastrophically
            cleanUpAudio();
            setState('idle');
            // Hide window if the stop attempt failed
            if (typeof window.electronAPI?.hideWindow === 'function') {
                window.electronAPI.hideWindow();
            }
        }
    }

    function handleDataAvailable(event) {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    }

    // handleStop: Triggered *after* mediaRecorder.stop() finishes flushing data.
    async function handleStop() {
        console.log("MediaRecorder 'stop' event triggered. Current state:", currentState);
        // Retrieve the flag set in stopRecording
        const shouldSaveAndProcess = !!mediaRecorder?.shouldSaveAndProcess;

        // Clear the flag now we've read it
        if (mediaRecorder) delete mediaRecorder.shouldSaveAndProcess;

        let processingSuccess = false; // Track if processing was initiated and succeeded

        if (shouldSaveAndProcess && recordedChunks.length > 0) {
             // State should already be 'processing' here
             console.log("Processing recorded data...");

            const finalBlob = new Blob(recordedChunks, { type: currentMimeType || 'audio/webm' });
            console.log(`Final Blob created: Size=${finalBlob.size}, Type=${finalBlob.type}`);

            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                const audioDataUint8Array = new Uint8Array(arrayBuffer);

                if (audioDataUint8Array.length === 0) {
                     throw new Error("Recorded audio data is empty.");
                }

                console.log(`Renderer: Sending ${audioDataUint8Array.length} bytes to main for transcription/copying.`);

                // --- Send to Main Process via Preload & AWAIT result ---
                if (typeof window.electronAPI?.transcribeAndCopy === 'function') {
                    try {
                        // Await the actual transcription/copy result from main
                        const result = await window.electronAPI.transcribeAndCopy(audioDataUint8Array);
                        if (result?.success) {
                            console.log("Renderer: Main process reported successful transcription/copy operation.");
                            processingSuccess = true; // Mark as successful
                        } else {
                            console.error("Renderer: Main process reported error during transcription/copy:", result?.error || "Unknown error");
                            // Error already shown via dialog in main process
                            processingSuccess = false; // Mark as failed
                        }
                    } catch (ipcError) {
                        console.error("Renderer: Error invoking transcribeAndCopy IPC:", ipcError);
                        alert("Error communicating with the main process for transcription.");
                        processingSuccess = false; // Mark as failed
                    }
                } else {
                    console.error("Renderer: Essential API function (transcribeAndCopy) unavailable!");
                    alert("Error: Cannot send audio for processing. Communication failed.");
                    processingSuccess = false; // Mark as failed
                }

            } catch (error) {
                console.error("Renderer: Error processing Blob or preparing audio data:", error);
                alert(`Error preparing audio: ${error.message}`);
                processingSuccess = false; // Mark as failed
            } finally {
                 // This block runs regardless of success/failure within the processing block
                 console.log("Renderer: Processing finished (or failed). Cleaning up audio resources.");
                 cleanUpAudio(); // Clean up mic/context
                 recordedChunks = []; // Clear chunks

                 // HIDE WINDOW AFTER PROCESSING COMPLETES (success or failure)
                 if (typeof window.electronAPI?.hideWindow === 'function') {
                     console.log("Renderer: Requesting window hide after processing attempt.");
                     window.electronAPI.hideWindow();
                 } else {
                     console.error("Renderer: Cannot hide window, API unavailable.");
                 }

                 // Set final state to IDLE *after* processing and hide request
                 setState('idle');
            }

        } else {
            // If recording was cancelled or empty
            console.log("Recording cancelled or no data recorded.");
            cleanUpAudio(); // Clean up resources immediately
            recordedChunks = []; // Clear chunks

            // HIDE WINDOW ON CANCEL
            if (typeof window.electronAPI?.hideWindow === 'function') {
                 console.log("Renderer: Requesting window hide after cancel/no data.");
                 window.electronAPI.hideWindow();
            } else {
                 console.error("Renderer: Cannot hide window, API unavailable.");
            }
            // Set final state to IDLE
            setState('idle');
        }
    }

    // --- Shortcut/Blur Event Handlers ---
    function handleTriggerStart() {
        console.log("Renderer: Received trigger-start-recording.");
        if (currentState === 'idle') {
            startRecording();
        } else {
            console.warn("Renderer: Ignoring trigger-start as state is not idle:", currentState);
        }
    }

    function handleTriggerStop(shouldSave) {
        console.log(`Renderer: Received trigger-stop-recording (save: ${shouldSave}). Current state: ${currentState}`);
        if (currentState === 'recording') {
            stopRecording(shouldSave);
        } else {
            console.warn("Renderer: Ignoring trigger-stop as state is not recording:", currentState);
             // If triggered while not recording (e.g., blur on idle/processing), ensure window hides eventually
             // The stopRecording(false) call in main.js on blur handles this path now.
             // We might still want to ensure cleanup if resources are somehow stuck.
            if (mediaStream || mediaRecorder || audioContext) {
                 console.warn("Renderer: Found active media resources despite non-recording state during stop trigger. Forcing cleanup.");
                 cleanUpAudio();
            }
            // Ensure we are in idle state if not recording
            if (currentState !== 'idle') {
                setState('idle');
            }
            // If window is still visible, hide it (e.g., blur on idle)
             if (typeof window.electronAPI?.hideWindow === 'function') {
                 console.log("Renderer: Requesting window hide because stop triggered while not recording.");
                 window.electronAPI.hideWindow();
             }
        }
    }

    // --- Cleanup ---
    function cleanUpAudio() {
        console.log("Cleaning up audio resources...");
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
             console.warn("Cleanup called while recorder state is active. Attempting track stop.");
             if (mediaStream) {
                mediaStream.getTracks().forEach(track => {
                    track.stop();
                    console.log("Track stopped during cleanup:", track.kind);
                });
             } else {
                 console.warn("MediaStream missing during active recorder cleanup.");
             }
        } else if (mediaStream) {
             mediaStream.getTracks().forEach(track => {
                 track.stop();
                 // console.log("Track stopped during normal cleanup:", track.kind);
             });
             mediaStream = null;
             // console.log("MediaStream tracks stopped.");
        }


        if (sourceNode) {
            try { sourceNode.disconnect(); } catch(e) {}
            sourceNode = null;
        }
        if (analyserNode) {
            try { analyserNode.disconnect(); } catch(e) {}
            analyserNode = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().then(() => {
                // console.log("AudioContext closed.");
            }).catch(e => console.warn("Error closing AudioContext:", e));
            audioContext = null;
        }
        if (mediaRecorder) {
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            mediaRecorder.onerror = null;
            mediaRecorder = null;
            // console.log("MediaRecorder instance released.");
        }

        recordedChunks = []; // Ensure chunks are always cleared
        isRecording = false; // Ensure internal flag is reset
        console.log("Audio cleanup complete.");
    }

    // --- Visualization ---
    function visualize() {
        if (!analyserNode || currentState !== 'recording') { // Check explicit state
            stopVisualization();
            return;
        }

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyserNode.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
        }
        const average = bufferLength > 0 ? sum / bufferLength : 0;
        const normalizedAmplitude = Math.min(1.0, Math.max(0, (average / 128.0) * 1.5));

        waveformHistory.push(normalizedAmplitude);
        if (waveformHistory.length > WAVEFORM_BAR_COUNT) {
            waveformHistory.shift();
        }

        drawWaveform(recordingCanvas, waveformHistory);

        animationFrameId = requestAnimationFrame(visualize);
    }

    function stopVisualization() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        // Clear the canvas when visualization stops
        if (recordingCanvas) {
            const ctx = recordingCanvas.getContext('2d');
             if (ctx) {
                 ctx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);
             }
        }
    }

    // --- Generic draw function - Only used for recording canvas ---
    function drawWaveform(canvas, historyData) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const centerY = height / 2;
        const numBars = historyData.length;
        const barWidth = numBars > 0 ? width / numBars : width;

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = Math.max(1, barWidth * 0.7);
        ctx.lineCap = 'round';

        ctx.beginPath();
        for (let i = 0; i < numBars; i++) {
            const amplitude = Math.max(historyData[i] || 0, 0.01); // Ensure min amplitude > 0
            const barHeight = Math.min(height, Math.max(1, amplitude * height * 0.9)); // Min height 1px
            const x = i * barWidth + barWidth / 2;
            const y1 = centerY - barHeight / 2;
            const y2 = centerY + barHeight / 2;

            ctx.moveTo(x, y1);
            ctx.lineTo(x, y2);
        }
        ctx.stroke();
    }

    // --- Timer ---
    function startTimer() {
        if (timerIntervalId) clearInterval(timerIntervalId);
        timerDisplay.textContent = "0:00";
        if (!recordingStartTime) recordingStartTime = Date.now();

        timerIntervalId = setInterval(() => {
            if (currentState !== 'recording' || !recordingStartTime) { // Check explicit state
                stopTimer();
                return;
            }
            const elapsedSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
            timerDisplay.textContent = formatTime(elapsedSeconds);
        }, 1000);
    }

    function stopTimer() {
        if (timerIntervalId) {
            clearInterval(timerIntervalId);
            timerIntervalId = null;
        }
        recordingStartTime = null; // Reset start time
        // Reset timer display? Optional, might want to keep last value visible briefly.
        // timerDisplay.textContent = "0:00";
    }

    // Helper to format seconds into MM:SS
    function formatTime(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // --- Public API ---
    return {
        init: init
    };
})();

// --- Initialize ---
document.addEventListener('DOMContentLoaded', AudioRecorder.init);