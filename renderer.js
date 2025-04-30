```javascript
// renderer.js
"use strict";

// Check essential APIs - Update this check based on the actual exposed API
if (typeof window.electronAPI?.transcribeAudio !== 'function' || // Adjusted API name
    typeof window.electronAPI?.hideWindow !== 'function' ||
    typeof window.electronAPI?.onTriggerStartRecording !== 'function' ||
    typeof window.electronAPI?.onTriggerStopRecording !== 'function' ||
    typeof window.electronAPI?.onFfmpegProgress !== 'function' ||
    typeof window.electronAPI?.cancelRetry !== 'function') {
    console.error("Electron API functions missing! Check preload script (ensure transcribeAudio, cancelRetry are exposed), contextIsolation, and main process IPC handlers.");
    // alert("Critical Error: Cannot communicate with the main process correctly. Functionality may be broken. Please check logs or restart.");
    // Gracefully degrade: disable the mic button if core functionality is missing
    const micButton = document.getElementById('micButton');
    if (micButton) {
        micButton.disabled = true;
        micButton.style.cursor = 'not-allowed';
        micButton.style.fill = '#666';
        micButton.title = "Recorder disabled due to missing API";
    }
    // Also try to update status message if available
     const statusMsg = document.getElementById('errorMessage'); // Use error message element
     if (statusMsg) {
         statusMsg.textContent = "Error: Core API missing.";
         statusMsg.style.display = 'block'; // Make it visible
     }
}


const AudioRecorder = (() => {
    // --- DOM Elements ---
    let recorderContainer;
    let micButton;
    let cancelRecordingButton;
    let confirmButton;
    let recordingCanvas;
    let timerDisplay;
    let cancelErrorButton;
    let retryButton;
    let processingInfo;
    let errorMessage;

    // --- Audio & State Variables ---
    let isRecording = false;
    let currentState = 'idle'; // 'idle', 'recording', 'processing', 'error'
    let mediaStream = null;
    let mediaRecorder = null;
    let audioContext = null;
    let analyserNode = null;
    let sourceNode = null;
    let recordedChunks = [];
    let recordingStartTime;
    let timerIntervalId = null;
    let animationFrameId = null;
    let lastAudioBuffer = null; // Store ArrayBuffer for potential retries

    const WAVEFORM_BAR_COUNT = 60;
    let waveformHistory = new Array(WAVEFORM_BAR_COUNT).fill(0);
    let currentMimeType = '';

    // --- Initialization ---
    function init() {
        recorderContainer = document.querySelector('.audio-recorder');
        micButton = document.getElementById('micButton');
        cancelRecordingButton = document.getElementById('cancelRecordingButton');
        confirmButton = document.getElementById('confirmButton');
        recordingCanvas = document.getElementById('recordingWaveformCanvas');
        timerDisplay = document.getElementById('timerDisplay');
        cancelErrorButton = document.getElementById('cancelErrorButton');
        retryButton = document.getElementById('retryButton');
        processingInfo = document.getElementById('processingInfo');
        errorMessage = document.getElementById('errorMessage');


        if (!recorderContainer || !micButton || !cancelRecordingButton || !confirmButton || !recordingCanvas || !timerDisplay || !cancelErrorButton || !retryButton || !errorMessage || !processingInfo) {
            console.error("Recorder UI elements not found! Check IDs in index.html.");
             if(errorMessage) errorMessage.textContent = "Error: UI elements missing.";
            return;
        }

        // Check again if API is available before adding listeners
        if (typeof window.electronAPI?.transcribeAudio === 'function' && // Use adjusted name
            typeof window.electronAPI?.hideWindow === 'function' &&
            typeof window.electronAPI?.onTriggerStartRecording === 'function' &&
            typeof window.electronAPI?.onTriggerStopRecording === 'function' &&
            typeof window.electronAPI?.onFfmpegProgress === 'function' &&
            typeof window.electronAPI?.cancelRetry === 'function') {

            micButton.addEventListener('click', startRecording);
            cancelRecordingButton.addEventListener('click', () => stopRecording(false));
            confirmButton.addEventListener('click', () => stopRecording(true));
            retryButton.addEventListener('click', handleRetry);
            cancelErrorButton.addEventListener('click', handleCancelError);

            window.electronAPI.onTriggerStartRecording(handleTriggerStart);
            window.electronAPI.onTriggerStopRecording(handleTriggerStop);
            window.electronAPI.onFfmpegProgress(handleFfmpegProgress);

            console.log("Audio Recorder Initialized and listeners added.");
        } else {
            console.error("Initialization skipped: Essential electronAPI functions not available.");
             recorderContainer.style.opacity = '0.5';
             recorderContainer.title = 'Recorder disabled due to internal error.';
             if (micButton) micButton.disabled = true; // Ensure disabled if API check failed here
             if (errorMessage) errorMessage.textContent = "Error: API unavailable.";
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

        // Clear potentially stale messages/info when changing state
        if (processingInfo) processingInfo.textContent = '';
        if (errorMessage) errorMessage.textContent = ''; // Clear previous errors

        recorderContainer.dataset.state = newState;
        isRecording = (newState === 'recording'); // Keep isRecording flag sync'd

        // Set specific text/visibility based on state
        if (newState === 'processing' && processingInfo) {
            processingInfo.textContent = 'Processing...'; // Default processing message
        }
        // Error messages are set directly in handleStop/handleRetry
    }

    // --- Recording Logic ---
    async function startRecording() {
        if (currentState !== 'idle' || typeof window.electronAPI?.transcribeAudio !== 'function') {
            console.warn(`Cannot start recording. Current state: ${currentState} or core API unavailable.`);
            return;
        }
        console.log("Attempting to start recording...");
        cleanUpAudio(); // Clean up any previous state
        recordedChunks = [];
        lastAudioBuffer = null; // Clear any previous buffer

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

            const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
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
            mediaRecorder.onstop = handleStop;
            mediaRecorder.onerror = (event) => {
                console.error("MediaRecorder error:", event.error);
                errorMessage.textContent = `Recording error: ${event.error.name}`;
                errorMessage.title = event.error.message;
                // Don't transition to 'error' state here, let stopRecording handle cleanup
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
            let userMessage = `Could not start recording: ${err.message}`;
             if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                 userMessage = "Microphone access was denied. Please allow access and try again.";
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                 userMessage = "No microphone found. Please ensure one is connected and enabled.";
            }
            // Display error in the dedicated element
             if (errorMessage) {
                errorMessage.textContent = userMessage;
                errorMessage.title = err.message; // Store full message in title
             } else {
                 alert(userMessage); // Fallback
             }
            cleanUpAudio();
            setState('idle'); // Revert to idle
        }
    }

    function stopRecording(shouldSaveAndProcess) {
        console.log(`Stopping recording. Save intent: ${shouldSaveAndProcess}. Current state: ${currentState}`);
        if (currentState !== 'recording' || !mediaRecorder || mediaRecorder.state === 'inactive') {
            console.log("Recorder not active or already stopped.");
            if (currentState === 'recording') {
                 console.warn("Stop requested while UI state is 'recording' but recorder inactive. Resetting.");
                 cleanUpAudio();
                 setState('idle');
                 if (typeof window.electronAPI?.hideWindow === 'function' && !shouldSaveAndProcess) { // Hide only if cancelling
                     window.electronAPI.hideWindow();
                 }
            }
            return;
        }

        stopVisualization();
        stopTimer();

        mediaRecorder.shouldSaveAndProcess = shouldSaveAndProcess;

        // Transition state immediately if processing, otherwise handleStop will manage it
        if (shouldSaveAndProcess) {
            setState('processing');
        } else {
            // If cancelling, we expect handleStop to clean up and go idle soon.
            // Don't change state here, let handleStop do it after recorder confirms stop.
        }


        try {
            mediaRecorder.stop();
            console.log("MediaRecorder stop requested.");
        } catch (error) {
            console.error("Error calling mediaRecorder.stop():", error);
             if (errorMessage) {
                errorMessage.textContent = "Error stopping recorder.";
                errorMessage.title = error.message;
             }
            cleanUpAudio();
            setState('idle');
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

    async function handleStop() {
        console.log("MediaRecorder 'stop' event triggered. Current UI state:", currentState);
        const shouldSaveAndProcess = !!mediaRecorder?.shouldSaveAndProcess;

        if (mediaRecorder) delete mediaRecorder.shouldSaveAndProcess;

        if (shouldSaveAndProcess && recordedChunks.length > 0) {
            console.log("Processing recorded data...");
            // State should be 'processing' if we are here

            const finalBlob = new Blob(recordedChunks, { type: currentMimeType || 'audio/webm' });

            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                lastAudioBuffer = arrayBuffer; // Store the buffer
                recordedChunks = []; // Clear chunks immediately

                if (!lastAudioBuffer || lastAudioBuffer.byteLength === 0) {
                    throw new Error("Recorded audio data is empty after processing.");
                }

                console.log(`Renderer: Sending ${lastAudioBuffer.byteLength} bytes for initial transcription.`);

                if (typeof window.electronAPI?.transcribeAudio === 'function') {
                    // Update processing message for clarity
                    if(processingInfo) processingInfo.textContent = 'Transcribing...';

                    const result = await window.electronAPI.transcribeAudio(lastAudioBuffer);

                    // Handle result object { success: boolean, error?: string }
                    if (result?.success) {
                        console.log("Renderer: Main process reported success.");
                        cleanUpAudio();
                        lastAudioBuffer = null; // Clear buffer on success
                        setState('idle');
                        // Main process hides window automatically on success
                    } else {
                        // Transcription failed
                        console.error("Renderer: Main process reported error:", result?.error || "Unknown transcription error");
                        errorMessage.textContent = result?.error || 'Transcription failed. Retry?';
                        errorMessage.title = result?.error || 'Transcription failed. Retry?';
                        setState('error'); // Transition to error state
                        // DO NOT clear lastAudioBuffer
                        cleanUpAudio(); // Clean up stream/context, but keep buffer reference
                    }
                } else {
                     throw new Error("Essential API function (transcribeAudio) unavailable!");
                }

            } catch (error) {
                console.error("Renderer: Error processing Blob or during initial IPC:", error);
                 if (errorMessage) {
                    errorMessage.textContent = "Error processing audio.";
                    errorMessage.title = error.message;
                 } else {
                     alert(`Error processing audio: ${error.message}`); // Fallback
                 }
                cleanUpAudio();
                lastAudioBuffer = null; // Clear buffer on local error
                 if (typeof window.electronAPI?.hideWindow === 'function') {
                     window.electronAPI.hideWindow();
                 }
                 setState('idle');
            }

        } else {
            // If recording was cancelled or no data recorded
            console.log("Recording cancelled or no data recorded. Cleaning up.");
            cleanUpAudio();
            lastAudioBuffer = null; // Clear buffer on cancel
            recordedChunks = [];

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
        if (currentState !== 'error' || !lastAudioBuffer) {
             console.warn(`Cannot retry. State: ${currentState}, Buffer available: ${!!lastAudioBuffer}`);
             if (!lastAudioBuffer && errorMessage) {
                 errorMessage.textContent = "Cannot retry: Audio data lost.";
                 errorMessage.title = "Cannot retry: Audio data lost.";
             }
             // Do not change state if already not in error
             return;
        }
        if (typeof window.electronAPI?.transcribeAudio !== 'function') {
            console.error("Retry failed: Transcription API unavailable.");
             if(errorMessage) {
                 errorMessage.textContent = "Retry failed: API unavailable.";
                 errorMessage.title = "Retry failed: API unavailable.";
             }
             setState('error'); // Stay in error state
            return;
        }

        setState('processing'); // Show spinner while retrying
        if(processingInfo) processingInfo.textContent = 'Retrying transcription...';

        try {
            console.log(`Renderer: Retrying transcription with ${lastAudioBuffer.byteLength} bytes.`);
            const result = await window.electronAPI.transcribeAudio(lastAudioBuffer);

            // Handle result object { success: boolean, error?: string }
            if (result?.success) {
                console.log("Renderer: Retry successful.");
                cleanUpAudio();
                lastAudioBuffer = null; // Clear buffer on success
                setState('idle');
                // Main process should hide window on success
            } else {
                // Retry failed again
                console.error("Renderer: Retry failed.", result?.error);
                errorMessage.textContent = result?.error || 'Retry failed. Try again?';
                errorMessage.title = result?.error || 'Retry failed. Try again?';
                setState('error'); // Stay in error state
                // DO NOT clear buffer
            }
        } catch (ipcError) {
            console.error("Renderer: Error invoking transcription IPC during retry:", ipcError);
             if(errorMessage) {
                 errorMessage.textContent = "Comms error during retry.";
                 errorMessage.title = ipcError.message;
             }
            setState('error'); // Revert to error state
        } finally {
             // Clear processing message if we are no longer processing (i.e., back in error state)
             if (currentState === 'error' && processingInfo) {
                 processingInfo.textContent = '';
             }
        }
    }

    function handleCancelError() {
        console.log("Renderer: Cancel error button clicked.");
        if (currentState !== 'error') return;

        if (typeof window.electronAPI?.cancelRetry === 'function') {
            window.electronAPI.cancelRetry(); // Tell main to delete file and hide
        } else {
            console.error("Renderer: cancelRetry API function unavailable!");
             if (typeof window.electronAPI?.hideWindow === 'function') {
                 window.electronAPI.hideWindow(); // Attempt to hide manually
             }
        }
        lastAudioBuffer = null; // Clear the buffer
        cleanUpAudio(); // Clean up renderer resources
        setState('idle'); // Go back to idle state
    }

    // --- Ffmpeg Progress Handler ---
    function handleFfmpegProgress(data) {
        console.log("Renderer: Received ffmpeg progress:", data);
        // Only display if we are currently in the processing state
        if (currentState === 'processing' && processingInfo && data)