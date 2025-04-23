// renderer.js
"use strict";

// Check essential APIs
if (typeof window.electronAPI?.transcribeAndCopy !== 'function' ||
    typeof window.electronAPI?.hideWindow !== 'function' ||
    typeof window.electronAPI?.onTriggerStartRecording !== 'function' ||
    typeof window.electronAPI?.onTriggerStopRecording !== 'function' ||
    // NEW: Check retry/cancel APIs
    typeof window.electronAPI?.retryTranscription !== 'function' ||
    typeof window.electronAPI?.onFfmpegProgress !== 'function' || // Check new listener
    typeof window.electronAPI?.cancelRetry !== 'function') {
    console.error("Electron API functions missing! Check preload script, contextIsolation, and main process IPC handlers (including new retry/cancel).");
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
    let cancelRecordingButton; // Renamed
    let confirmButton;
    let recordingCanvas;
    let timerDisplay;
    // NEW: Error state elements
    let cancelErrorButton;
    let retryButton;
    let processingInfo; // NEW: Element for ffmpeg info
    let errorMessage;

    // --- Audio & State Variables ---
    let isRecording = false; // Reflects if mediaRecorder is active
    let currentState = 'idle'; // Track current UI state explicitly ('idle', 'recording', 'processing', 'error')
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
        cancelRecordingButton = document.getElementById('cancelRecordingButton'); // Updated ID
        confirmButton = document.getElementById('confirmButton');
        recordingCanvas = document.getElementById('recordingWaveformCanvas');
        timerDisplay = document.getElementById('timerDisplay');
        // NEW: Find error state elements
        cancelErrorButton = document.getElementById('cancelErrorButton');
        retryButton = document.getElementById('retryButton');
        processingInfo = document.getElementById('processingInfo'); // Get the new element
        errorMessage = document.getElementById('errorMessage');


        if (!recorderContainer || !micButton || !cancelRecordingButton || !confirmButton || !recordingCanvas || !timerDisplay || !cancelErrorButton || !retryButton || !errorMessage || !processingInfo) {
            console.error("Recorder UI elements not found! Check IDs in index.html (including error state).");
            return;
        }

        // Check again if API is available before adding listeners
        if (typeof window.electronAPI?.transcribeAndCopy === 'function' &&
            typeof window.electronAPI?.hideWindow === 'function' &&
            typeof window.electronAPI?.onTriggerStartRecording === 'function' &&
            typeof window.electronAPI?.onTriggerStopRecording === 'function' &&
            // NEW: Check retry/cancel APIs
            typeof window.electronAPI?.onFfmpegProgress === 'function' &&
            typeof window.electronAPI?.retryTranscription === 'function' &&
            typeof window.electronAPI?.cancelRetry === 'function') {

            micButton.addEventListener('click', startRecording);
            cancelRecordingButton.addEventListener('click', () => stopRecording(false)); // Cancel during recording
            confirmButton.addEventListener('click', () => stopRecording(true)); // Confirm recording

            // NEW: Add listeners for error state buttons
            retryButton.addEventListener('click', handleRetry);
            cancelErrorButton.addEventListener('click', handleCancelError);

            // Listen for triggers from main process
            window.electronAPI.onTriggerStartRecording(handleTriggerStart);
            window.electronAPI.onTriggerStopRecording(handleTriggerStop);

            // Listen for ffmpeg progress updates
            window.electronAPI.onFfmpegProgress(handleFfmpegProgress);

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
        if (currentState === newState) return; // Avoid unnecessary changes
        console.log(`State changing from ${currentState} to ${newState}`);
        currentState = newState;
        // Clear processing info when NOT in processing state
        if (newState !== 'processing' && processingInfo) {
            processingInfo.textContent = '';
        }
        recorderContainer.dataset.state = newState;
        isRecording = (newState === 'recording'); // Keep isRecording flag sync'd
    }

    // --- Recording Logic ---
    async function startRecording() {
        // Allow starting only from idle state
        if (currentState !== 'idle' || typeof window.electronAPI?.transcribeAndCopy !== 'function') {
            console.warn(`Cannot start recording. Current state: ${currentState} or core API unavailable.`);
            return;
        }
        console.log("Attempting to start recording...");
        // Clean up any previous potential errors before starting fresh
        cleanUpAudio();
        recordedChunks = [];

        // setState('starting'); // Optional intermediate state

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("Microphone access granted.");

            waveformHistory.fill(0);
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
            mediaRecorder.onstop = handleStop; // Centralized processing/state logic
            mediaRecorder.onerror = (event) => {
                console.error("MediaRecorder error:", event.error);
                alert(`Recording error: ${event.error.name} - ${event.error.message}`);
                stopRecording(false); // Cancel on recorder error
            };

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
            cleanUpAudio(); // Clean up on failure
            setState('idle'); // Revert to idle
        }
    }

    function stopRecording(shouldSaveAndProcess) {
        console.log(`Stopping recording. Save intent: ${shouldSaveAndProcess}. Current state: ${currentState}`);
        if (currentState !== 'recording' || !mediaRecorder || mediaRecorder.state === 'inactive') {
            console.log("Recorder not active or already stopped.");
            // If somehow stuck in recording state visually but recorder inactive, reset
            if (currentState === 'recording') {
                 console.warn("Stop requested while UI state is 'recording' but recorder inactive. Resetting.");
                 cleanUpAudio();
                 setState('idle');
                 if (typeof window.electronAPI?.hideWindow === 'function') {
                     window.electronAPI.hideWindow(); // Ensure hide on this edge case cancel
                 }
            }
            return;
        }

        stopVisualization();
        stopTimer();

        // Attach the save flag for handleStop to access
        mediaRecorder.shouldSaveAndProcess = shouldSaveAndProcess;

        // Transition to 'processing' state *only* if saving.
        // If cancelling, handleStop will transition directly to 'idle'.
        if (shouldSaveAndProcess) {
            if (processingInfo) processingInfo.textContent = 'Converting...'; // Initial message
            setState('processing');
        }

        try {
            mediaRecorder.stop(); // This triggers handleStop asynchronously
            console.log("MediaRecorder stop requested.");
        } catch (error) {
            console.error("Error calling mediaRecorder.stop():", error);
            // Force cleanup and idle state if stopping fails catastrophically
            cleanUpAudio();
            setState('idle');
             // Hide window if the stop attempt failed catastrophically
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

    // handleStop: Triggered *after* mediaRecorder.stop() finishes. Handles initial processing attempt.
    async function handleStop() {
        console.log("MediaRecorder 'stop' event triggered. Current UI state:", currentState);
        const shouldSaveAndProcess = !!mediaRecorder?.shouldSaveAndProcess;

        if (mediaRecorder) delete mediaRecorder.shouldSaveAndProcess; // Clear the flag

        if (shouldSaveAndProcess && recordedChunks.length > 0) {
            // State should be 'processing' here if we got here via shouldSaveAndProcess=true
            console.log("Processing recorded data...");

            const finalBlob = new Blob(recordedChunks, { type: currentMimeType || 'audio/webm' });
            recordedChunks = []; // Clear chunks immediately after creating blob
            console.log(`Final Blob created: Size=${finalBlob.size}, Type=${finalBlob.type}`);

            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                const audioDataUint8Array = new Uint8Array(arrayBuffer);

                if (audioDataUint8Array.length === 0) {
                    throw new Error("Recorded audio data became empty after blob conversion.");
                }

                console.log(`Renderer: Sending ${audioDataUint8Array.length} bytes to main for initial transcription attempt.`);

                if (typeof window.electronAPI?.transcribeAndCopy === 'function') {
                    const result = await window.electronAPI.transcribeAndCopy(audioDataUint8Array);

                    if (result?.success) {
                        console.log("Renderer: Main process reported successful transcription/copy.");
                        cleanUpAudio(); // Clean up mic/context on success
                        // Main process handles hiding on success
                        setState('idle'); // Transition to idle
                    } else {
                        // Transcription failed, check if retryable
                        console.error("Renderer: Main process reported error:", result?.error || "Unknown error");
                        if (result?.retryable) {
                            console.log("Renderer: Error is retryable. Entering error state.");
                            errorMessage.textContent = result.error || 'Transcription failed. Retry?'; // Update error message UI
                            errorMessage.title = result.error || 'Transcription failed. Retry?'; // Add tooltip for long messages
                            setState('error'); // Transition to error state
                            // DO NOT hide window, DO NOT cleanup audio fully yet (main keeps file)
                            cleanUpAudio(); // Still clean up stream/context resources
                        } else {
                            // Non-retryable error
                            console.log("Renderer: Error is not retryable. Returning to idle.");
                            // Main process should have shown a dialog and will handle hiding.
                            cleanUpAudio(); // Clean up everything
                            setState('idle'); // Transition to idle
                        }
                    }
                } else {
                     throw new Error("Essential API function (transcribeAndCopy) unavailable!");
                }

            } catch (error) {
                console.error("Renderer: Error processing Blob or during initial IPC:", error);
                alert(`Error processing audio: ${error.message}`);
                cleanUpAudio(); // Clean up on local processing error
                // Request hide window on error
                 if (typeof window.electronAPI?.hideWindow === 'function') {
                     window.electronAPI.hideWindow();
                 }
                 setState('idle');
            }

        } else {
            // If recording was cancelled (shouldSaveAndProcess=false) or no data recorded
            console.log("Recording cancelled or no data recorded. Cleaning up.");
            cleanUpAudio(); // Clean up resources immediately
            recordedChunks = []; // Ensure chunks are cleared

            // HIDE WINDOW ON CANCEL
            if (typeof window.electronAPI?.hideWindow === 'function') {
                 console.log("Renderer: Requesting window hide after cancel/no data.");
                 window.electronAPI.hideWindow();
            }
            setState('idle'); // Go directly to idle
        }
    }

    // --- NEW: Error State Handling ---

    async function handleRetry() {
        console.log("Renderer: Retry button clicked.");
        if (currentState !== 'error' || typeof window.electronAPI?.retryTranscription !== 'function') {
             console.warn(`Cannot retry. State: ${currentState} or API unavailable.`);
             return;
        }

        setState('processing'); // Show spinner while retrying

        try {
            const result = await window.electronAPI.retryTranscription();

            if (result?.success) {
                console.log("Renderer: Retry successful.");
                cleanUpAudio(); // Ensure cleanup after successful retry
                // Main process hides window on success
                setState('idle');
            } else {
                // Retry failed
                console.error("Renderer: Retry failed.", result?.error);
                if (result?.retryable) {
                    // Still retryable, update message and return to error state
                    errorMessage.textContent = result.error || 'Retry failed. Try again?';
                    errorMessage.title = result.error || 'Retry failed. Try again?';
                    setState('error');
                } else {
                    // Non-retryable failure after retry
                    console.log("Renderer: Retry failed permanently.");
                    alert("Transcription failed permanently: " + (result?.error || "Unknown error")); // Show final error
                    cleanUpAudio();
                    // Main process should handle hiding on non-retryable failure
                    setState('idle');
                }
            }
        } catch (ipcError) {
            console.error("Renderer: Error invoking retryTranscription IPC:", ipcError);
            alert("Error communicating with the main process for retry.");
            // Revert to error state on communication failure
            errorMessage.textContent = "Comms error on retry.";
            errorMessage.title = "Comms error on retry.";
            setState('error');
        }
    }

    function handleCancelError() {
        console.log("Renderer: Cancel error button clicked.");
        if (currentState !== 'error') return;

        if (typeof window.electronAPI?.cancelRetry === 'function') {
            window.electronAPI.cancelRetry(); // Tell main to delete file and hide
        } else {
            console.error("Renderer: cancelRetry API function unavailable!");
            // Attempt to hide manually if API is missing
             if (typeof window.electronAPI?.hideWindow === 'function') {
                 window.electronAPI.hideWindow();
             }
        }
        cleanUpAudio(); // Clean up renderer resources
        setState('idle'); // Go back to idle state
    }

    // --- NEW: Ffmpeg Progress Handler ---
    function handleFfmpegProgress(data) {
        console.log("Renderer: Received ffmpeg progress:", data);
        if (currentState === 'processing' && processingInfo && data) {
             const { originalFormatted, convertedFormatted, reductionPercent } = data;
             // Example: "WebM: 1.2MB -> MP3: 180KB (85% smaller)"
             // Or just the reduction: "Size reduced by 85%"
             processingInfo.textContent = `${originalFormatted} -> ${convertedFormatted} (${reductionPercent}% smaller)`;
        }
    }

    // --- Shortcut/Trigger Handlers ---
    function handleTriggerStart() {
        console.log("Renderer: Received trigger-start-recording.");
        if (currentState === 'idle') {
            startRecording();
        } else if (currentState === 'error') {
            // If shortcut pressed in error state, treat as cancel
            console.log("Renderer: Start trigger received in error state. Interpreting as cancel.");
            handleCancelError();
        } else {
            console.warn("Renderer: Ignoring trigger-start as state is not idle or error:", currentState);
        }
    }

    function handleTriggerStop(shouldSave) {
        console.log(`Renderer: Received trigger-stop-recording (save: ${shouldSave}). Current state: ${currentState}`);
        if (currentState === 'recording') {
            stopRecording(shouldSave);
        } else if (currentState === 'error') {
             // If shortcut pressed again in error state, also treat as cancel
            console.log("Renderer: Stop trigger received in error state. Interpreting as cancel.");
            handleCancelError();
        } else {
            console.warn("Renderer: Ignoring trigger-stop as state is not recording or error:", currentState);
             // If triggered while idle/processing, potentially hide if visible
             if (currentState === 'idle' || currentState === 'processing') {
                  if (typeof window.electronAPI?.hideWindow === 'function') {
                     console.log("Renderer: Requesting window hide because stop triggered while not recording/error.");
                     window.electronAPI.hideWindow();
                 }
             }
        }
    }

    // --- Cleanup ---
    function cleanUpAudio() {
        console.log("Cleaning up audio resources...");
        // Stop tracks if mediaStream exists
         if (mediaStream) {
             mediaStream.getTracks().forEach(track => {
                 track.stop();
                 // console.log("Track stopped during cleanup:", track.kind);
             });
             mediaStream = null;
             // console.log("MediaStream tracks stopped.");
         }

        // Disconnect and nullify audio nodes
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch(e) {}
            sourceNode = null;
        }
        if (analyserNode) {
            try { analyserNode.disconnect(); } catch(e) {}
            analyserNode = null;
        }
        // Close audio context
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().then(() => {
                // console.log("AudioContext closed.");
            }).catch(e => console.warn("Error closing AudioContext:", e));
            audioContext = null;
        }
        // Release MediaRecorder instance
        if (mediaRecorder) {
             // Make sure onstop isn't called again during cleanup if stop() failed earlier
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            mediaRecorder.onerror = null;
             // Check state before trying to stop again, might already be inactive
             if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
                 try {
                     mediaRecorder.stop(); // Attempt a final stop if needed
                     console.log("MediaRecorder stopped during cleanup.");
                 } catch (e) {
                     console.warn("Error stopping MediaRecorder during cleanup:", e);
                 }
             }
            mediaRecorder = null;
            // console.log("MediaRecorder instance released.");
        }

        // Clear flags and visual elements
        isRecording = false;
        stopVisualization();
        stopTimer();
        // Don't clear recordedChunks here, handleStop manages that after potential processing

        console.log("Audio cleanup complete.");
    }

    // --- Visualization ---
    function visualize() {
        if (!analyserNode || currentState !== 'recording') {
            stopVisualization();
            return;
        }

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        try { // Add try/catch as analyserNode might become invalid
             analyserNode.getByteFrequencyData(dataArray);
        } catch (error) {
            console.warn("Error getting frequency data, stopping visualization:", error);
            stopVisualization();
            return;
        }


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
        if (recordingCanvas) {
            const ctx = recordingCanvas.getContext('2d');
             if (ctx) {
                 ctx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);
             }
        }
    }

    function drawWaveform(canvas, historyData) {
        // ... (keep existing drawWaveform code) ...
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
        // ... (keep existing startTimer code) ...
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
        // ... (keep existing stopTimer code) ...
        if (timerIntervalId) {
            clearInterval(timerIntervalId);
            timerIntervalId = null;
        }
        recordingStartTime = null; // Reset start time
        // Reset timer display? Optional, might want to keep last value visible briefly.
        // timerDisplay.textContent = "0:00";
    }

    function formatTime(totalSeconds) {
        // ... (keep existing formatTime code) ...
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