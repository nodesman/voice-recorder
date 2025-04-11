// renderer.js
"use strict";

// Check essential APIs
if (typeof window.electronAPI?.transcribeAndPaste !== 'function' ||
    typeof window.electronAPI?.hideWindow !== 'function' ||
    typeof window.electronAPI?.onTriggerStartRecording !== 'function' ||
    typeof window.electronAPI?.onTriggerStopRecording !== 'function') {
    console.error("Electron API functions missing! Check preload script, contextIsolation, and main process IPC handlers.");
    alert("Critical Error: Cannot communicate with the main process correctly. Functionality may be broken. Please check logs or restart.");
    // Optionally disable UI elements
    const micButton = document.getElementById('micButton');
    if (micButton) {
        micButton.disabled = true;
        micButton.style.cursor = 'not-allowed';
        micButton.style.fill = '#666'; // Dim the icon
    }
}

const AudioRecorder = (() => {
    // --- DOM Elements ---
    let recorderContainer;
    let micButton;
    let cancelButton;
    let confirmButton;
    let recordingCanvas;
    // Remove: processingCanvas, totalDurationDisplay, transcriptionDisplay
    let timerDisplay;

    // --- Audio & State Variables ---
    let isRecording = false;
    let mediaStream = null;
    let mediaRecorder = null;
    let audioContext = null;
    let analyserNode = null;
    let sourceNode = null;
    let recordedChunks = [];
    let recordingStartTime;
    let timerIntervalId = null;
    let animationFrameId = null;
    // Remove: transcriptionTimeoutId

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
        // Remove assignments for removed elements

        if (!recorderContainer || !micButton || !cancelButton || !confirmButton || !recordingCanvas || !timerDisplay) {
            console.error("Recorder UI elements not found! Check IDs in index.html.");
            return; // Stop initialization
        }

        // Check again if API is available before adding listeners
        if (typeof window.electronAPI?.transcribeAndPaste === 'function' &&
            typeof window.electronAPI?.hideWindow === 'function' &&
            typeof window.electronAPI?.onTriggerStartRecording === 'function' &&
            typeof window.electronAPI?.onTriggerStopRecording === 'function') {

            micButton.addEventListener('click', startRecording); // Still allow manual click to start
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
        if (!recorderContainer) return; // Guard against missing container

        // Remove processing state logic
        recorderContainer.dataset.state = newState;
        isRecording = (newState === 'recording');

        console.log("State changed to:", newState);
    }

    // --- Recording Logic ---
    async function startRecording() {
        // Use API check relevant to this function
        if (isRecording || typeof window.electronAPI?.transcribeAndPaste !== 'function') {
            console.warn("Cannot start recording. Already recording or core API unavailable.");
            return;
        }
        console.log("Attempting to start recording...");

        // Remove UI reset related to transcriptionDisplay

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("Microphone access granted.");

            // Reset state
            waveformHistory.fill(0);
            recordedChunks = [];
            if (timerIntervalId) clearInterval(timerIntervalId);
            if (animationFrameId) cancelAnimationFrame(animationFrameId);

            // Setup Web Audio API
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            sourceNode = audioContext.createMediaStreamSource(mediaStream);
            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 256;
            analyserNode.smoothingTimeConstant = 0.6;
            sourceNode.connect(analyserNode);

            // Setup MediaRecorder
            const mimeTypes = [
                'audio/webm;codecs=opus',
                'audio/ogg;codecs=opus',
                'audio/webm',
                'audio/mp4',
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

            // Assign event handlers
            mediaRecorder.ondataavailable = handleDataAvailable;
            mediaRecorder.onstop = handleStop;

            // Start
            mediaRecorder.start(100);
            recordingStartTime = Date.now();
            setState('recording');
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
            setState('idle');
        }
    }

    function stopRecording(shouldSaveAndProcess) {
        console.log(`Stopping recording. Save intent: ${shouldSaveAndProcess}`);
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            console.log("Recorder not active or already stopped.");
            if (recorderContainer?.dataset.state !== 'idle') {
                // Ensure cleanup if stop is called while not idle but recorder is inactive
                cleanUpAudio();
                stopTimer();
                stopVisualization();
                setState('idle');
            }
            return;
        }

        // Attach the save flag
        mediaRecorder.shouldSaveAndProcess = shouldSaveAndProcess;

        // Request stop
        try {
            mediaRecorder.stop(); // handleStop will execute on completion
        } catch (error) {
            console.error("Error calling mediaRecorder.stop():", error);
            // Force cleanup and idle state if stopping fails
            cleanUpAudio();
            setState('idle');
        }

        // Stop visual feedback immediately
        stopVisualization();
        stopTimer();
    }

    function handleDataAvailable(event) {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    }

    // handleStop: Triggered automatically when mediaRecorder.stop() finishes
    async function handleStop() {
        console.log("MediaRecorder 'stop' event triggered.");
        const shouldSaveAndProcess = !!mediaRecorder?.shouldSaveAndProcess;
        // Remove reference to finalDuration as it's not displayed

        if (mediaRecorder) delete mediaRecorder.shouldSaveAndProcess; // Clean up flag

        if (shouldSaveAndProcess && recordedChunks.length > 0) {
            // No 'processing' state change
            // Remove UI updates for processing state

            const finalBlob = new Blob(recordedChunks, { type: currentMimeType || 'audio/webm' });
            console.log(`Final Blob created: Size=${finalBlob.size}, Type=${finalBlob.type}`);

            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                const audioDataUint8Array = new Uint8Array(arrayBuffer);

                if (audioDataUint8Array.length === 0) {
                     throw new Error("Converted audio data is empty.");
                }

                console.log(`Renderer: Sending ${audioDataUint8Array.length} bytes to main for transcription/pasting.`);
                // Remove setting transcriptionDisplay text

                // --- Send to Main Process via Preload ---
                if (typeof window.electronAPI?.transcribeAndPaste === 'function' &&
                    typeof window.electronAPI?.hideWindow === 'function') {

                    // Initiate transcription/pasting (async, don't await the full process here)
                    window.electronAPI.transcribeAndPaste(audioDataUint8Array)
                        .then(result => {
                            if (result?.success) {
                                console.log("Renderer: Main process reported successful transcription/paste operation.");
                            } else {
                                // Error is now handled by main process dialog
                                console.error("Renderer: Main process reported error:", result?.error || "Unknown error");
                                // No UI element to display the error here
                            }
                        })
                        .catch(ipcError => {
                            console.error("Renderer: Error invoking transcribeAndPaste IPC:", ipcError);
                             // No UI element to display the error here
                             // A main process dialog might be appropriate here too, or rely on console logs
                        });

                    // --- Hide the window immediately after sending ---
                    console.log("Renderer: Requesting window hide.");
                    window.electronAPI.hideWindow();

                } else {
                    console.error("Renderer: Essential API functions (transcribeAndPaste/hideWindow) unavailable!");
                    alert("Error: Cannot send audio or hide window. Communication failed.");
                }

            } catch (error) {
                console.error("Renderer: Error processing Blob or preparing audio data:", error);
                 alert(`Error preparing audio: ${error.message}`); // Show error to user
                 // No UI element to display the error persistently
            } finally {
                // Always go back to idle and clean up after attempting to save/process
                console.log("Renderer: Finalizing stop (save path), setting state to idle.");
                setState('idle'); // Go back to idle state *after* initiating hide/process
                cleanUpAudio(); // Clean up resources like mic stream
                recordedChunks = []; // Clear chunks for next recording
            }

        } else {
            // If recording was cancelled or empty
            console.log("Recording cancelled or no data recorded.");
            setState('idle'); // Go back to idle
            cleanUpAudio(); // Clean up resources immediately
            recordedChunks = []; // Clear chunks
            // If the window is still visible (e.g., manual cancel click), hide it
            if (typeof window.electronAPI?.hideWindow === 'function') {
                 // Check if window is actually visible? Maybe not necessary, main checks.
                 console.log("Renderer: Requesting window hide after cancel.");
                 window.electronAPI.hideWindow();
            }
        }

        // Redundant cleanup check, handled within the if/else branches now
        // if (recorderContainer.dataset.state !== 'processing') { ... } removed
    }

    // --- NEW: Shortcut/Blur Event Handlers ---
    function handleTriggerStart() {
        console.log("Renderer: Received trigger-start-recording.");
        // Ensure we are in idle state before starting
        if (recorderContainer.dataset.state === 'idle') {
            startRecording();
        } else {
            console.warn("Renderer: Ignoring trigger-start as state is not idle:", recorderContainer.dataset.state);
        }
    }

    function handleTriggerStop(shouldSave) {
        console.log(`Renderer: Received trigger-stop-recording (save: ${shouldSave}).`);
        // Ensure we are actually recording before stopping
        if (recorderContainer.dataset.state === 'recording') {
            stopRecording(shouldSave);
        } else {
            console.warn("Renderer: Ignoring trigger-stop as state is not recording:", recorderContainer.dataset.state);
             // If triggered while not recording (e.g. blur on idle), ensure window hides
            if (typeof window.electronAPI?.hideWindow === 'function') {
                 console.log("Renderer: Requesting window hide because stop triggered while not recording.");
                 window.electronAPI.hideWindow();
            }
             // Ensure cleanup if somehow resources are active but state is wrong
             if (mediaStream || mediaRecorder) {
                 console.warn("Renderer: Found active media resources despite non-recording state during stop trigger. Forcing cleanup.");
                 cleanUpAudio();
                 setState('idle'); // Correct state
             }
        }
    }


    // --- Cleanup ---
    function cleanUpAudio() {
        console.log("Cleaning up audio resources...");
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
             console.warn("Cleanup called while recorder state indicates recording. This shouldn't normally happen.");
             // If stopRecording failed or wasn't called, try stopping tracks directly
             if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
             }
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop()); // Ensure tracks are stopped
            mediaStream = null;
            console.log("MediaStream tracks stopped.");
        }
        if (sourceNode) {
            sourceNode.disconnect();
            sourceNode = null;
        }
        if (analyserNode) {
            analyserNode.disconnect();
            analyserNode = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().then(() => {
                console.log("AudioContext closed.");
            }).catch(e => console.warn("Error closing AudioContext:", e));
            audioContext = null;
        }
        if (mediaRecorder) {
            // Prevent further events if recorder is mid-stop
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            mediaRecorder.onerror = null; // Add onerror just in case
            mediaRecorder = null;
            console.log("MediaRecorder instance released.");
        }

        // Reset chunks explicitly
        recordedChunks = [];
        console.log("Audio cleanup complete.");
    }

    // --- Visualization ---
    function visualize() {
        // Check against actual recording state derived from dataset.state
        if (!analyserNode || recorderContainer?.dataset.state !== 'recording') {
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

        // Only draw on recording canvas
        drawWaveform(recordingCanvas, waveformHistory);

        animationFrameId = requestAnimationFrame(visualize);
    }

    function stopVisualization() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        if (recordingCanvas) {
            const ctx = recordingCanvas.getContext('2d');
             if (ctx) {
                 ctx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);
             }
        }
    }

    // Generic draw function - Only used for recording canvas now
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
            const amplitude = Math.max(historyData[i] || 0, 0.01);
            const barHeight = Math.min(height, Math.max(1, amplitude * height * 0.9));
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
            // Check against actual recording state
            if (recorderContainer?.dataset.state !== 'recording' || !recordingStartTime) {
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
        recordingStartTime = null;
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
        // Expose start/stop for potential external control? Not needed currently.
        // start: startRecording,
        // stop: stopRecording
    };
})();

// --- Initialize ---
document.addEventListener('DOMContentLoaded', AudioRecorder.init);