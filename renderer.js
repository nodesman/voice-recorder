// renderer.js
"use strict";

// Check essential APIs - Update this check based on the actual exposed API
if (typeof window.electronAPI?.transcribeAudio !== 'function' || // Adjusted API name
    typeof window.electronAPI?.hideWindow !== 'function' ||
    typeof window.electronAPI?.onTriggerStartRecording !== 'function' ||
    typeof window.electronAPI?.onTriggerStopRecording !== 'function' ||
    typeof window.electronAPI?.onFfmpegProgress !== 'function' ||
    typeof window.electronAPI?.cancelRetry !== 'function' ||
    typeof window.electronAPI?.retryTranscription !== 'function') { // Added retryTranscription check
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
            if (errorMessage) errorMessage.textContent = "Error: UI elements missing.";
            return;
        }

        // Check again if API is available before adding listeners
        if (typeof window.electronAPI?.transcribeAudio === 'function' && // Use adjusted name
            typeof window.electronAPI?.hideWindow === 'function' &&
            typeof window.electronAPI?.onTriggerStartRecording === 'function' &&
            typeof window.electronAPI?.onTriggerStopRecording === 'function' &&
            typeof window.electronAPI?.onFfmpegProgress === 'function' &&
            typeof window.electronAPI?.cancelRetry === 'function' &&
            typeof window.electronAPI?.retryTranscription === 'function') { // Added retryTranscription check

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
            mediaStream = await navigator.mediaDevices.getUserMedia({audio: true});
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
            const options = currentMimeType ? {mimeType: currentMimeType} : {};
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

            const finalBlob = new Blob(recordedChunks, {type: currentMimeType || 'audio/webm'});

            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                lastAudioBuffer = arrayBuffer; // Store the buffer
                recordedChunks = []; // Clear chunks immediately

                if (!lastAudioBuffer || lastAudioBuffer.byteLength === 0) {
                    throw new Error("Recorded audio data is empty after processing.");
                }

                const audioDataUint8Array = new Uint8Array(lastAudioBuffer); // Convert ArrayBuffer to Uint8Array
                console.log(`Renderer: Sending ${audioDataUint8Array.length} bytes for initial transcription.`);

                if (typeof window.electronAPI?.transcribeAudio === 'function') {
                    // Update processing message for clarity
                    if (processingInfo) processingInfo.textContent = 'Transcribing...';

                    const result = await window.electronAPI.transcribeAudio(audioDataUint8Array); // Pass Uint8Array

                    // Handle result object { success: boolean, error?: string, retryable?: boolean }
                    if (result?.success) {
                        console.log("Renderer: Main process reported success.");
                        cleanUpAudio();
                        lastAudioBuffer = null; // Clear buffer on success
                        setState('idle');
                        // Main process hides window automatically on success
                    } else if (result?.retryable) {
                        // Transcription failed, but is retryable
                        console.error("Renderer: Main process reported retryable error:", result?.error);
                        errorMessage.textContent = result?.error || 'Transcription failed. Retry?';
                        errorMessage.title = result?.error || 'Transcription failed. Retry?';
                        setState('error'); // Transition to error state
                        // DO NOT clear lastAudioBuffer (main.js has the MP3 for retry)
                        cleanUpAudio(); // Clean up stream/context, but main keeps the MP3
                    } else {
                        // Transcription failed, non-retryable
                        console.error("Renderer: Main process reported non-retryable error:", result?.error);
                        errorMessage.textContent = result?.error || 'Transcription failed.';
                        errorMessage.title = result?.error || 'Transcription failed.';
                        // Main process handles any dialogs for critical non-retryable errors.
                        // We still go to 'error' state to show the message, user can then cancel to hide.
                        setState('error');
                        cleanUpAudio(); // Clean up stream/context
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
        console.log("Renderer: Retry button clicked. Requesting file-based retry from main process.");
        if (currentState !== 'error') {
            console.warn(`Cannot retry. State is not 'error': ${currentState}`);
            return;
        }
        // No need to check lastAudioBuffer here, main.js uses its own stored file.
        if (typeof window.electronAPI?.retryTranscription !== 'function') {
            // Do not change state if already not in error
            console.error("Retry failed: Transcription API unavailable.");
            if (errorMessage) {
                errorMessage.textContent = "Retry failed: API unavailable.";
                errorMessage.title = "Retry failed: API unavailable.";
            }
            setState('error'); // Stay in error state
            return;
        }

        setState('processing'); // Show spinner while retrying
        if (processingInfo) processingInfo.textContent = 'Retrying transcription...';

        try {
            // Call the main process's file-based retry mechanism
            const result = await window.electronAPI.retryTranscription();

            // Handle result object { success: boolean, error?: string, retryable?: boolean }
            if (result?.success) {
                console.log("Renderer: Retry successful.");
                cleanUpAudio();
                lastAudioBuffer = null; // Clear buffer on success
                setState('idle');
                // Main process should hide window on success
            } else if (result?.retryable) {
                // Retry failed, but is still retryable
                console.error("Renderer: Retry failed, but still retryable.", result?.error);
                errorMessage.textContent = result?.error || 'Retry failed. Try again?';
                errorMessage.title = result?.error || 'Retry failed. Try again?';
                setState('error'); // Stay in error state for another attempt
                // DO NOT clear lastAudioBuffer (main.js handles its file)
            } else {
                // Retry failed with a non-retryable error
                console.error("Renderer: Retry failed with non-retryable error.", result?.error);
                errorMessage.textContent = result?.error || 'Retry failed permanently.';
                errorMessage.title = result?.error || 'Retry failed permanently.';
                setState('error'); // Stay in error state, user must cancel
                // Main process would handle final dialogs and its temp file cleanup.
            }
        } catch (ipcError) {
            console.error("Renderer: Error invoking transcription IPC during retry:", ipcError);
            if (errorMessage) {
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
        if (currentState === 'processing' && processingInfo && data) { // Scoping the constants
            const {originalFormatted, convertedFormatted, reductionPercent} = data;
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
            try {
                sourceNode.disconnect();
            } catch (e) {
            }
            sourceNode = null;
        }
        if (analyserNode) {
            try {
                analyserNode.disconnect();
            } catch (e) {
            }
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

    // --- Timer ---
    function startTimer() {
        if (timerIntervalId) clearInterval(timerIntervalId);
        timerDisplay.textContent = "0:00";
        const startTime = Date.now();
        timerIntervalId = setInterval(() => {
            const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            timerDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    function stopTimer() {
        if (timerIntervalId) {
            clearInterval(timerIntervalId);
            timerIntervalId = null;
        }
        if (timerDisplay) timerDisplay.textContent = "0:00";
    }

    // --- Waveform Drawing ---
    function drawWaveform(canvas, history) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const barWidth = width / WAVEFORM_BAR_COUNT;
        const barColor = 'rgba(200, 200, 200, 0.6)'; // Lighter, slightly transparent bars
        const centerLineColor = 'rgba(150, 150, 150, 0.3)'; // Fainter center line

        // Draw center line
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.strokeStyle = centerLineColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw bars
        for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
            const x = i * barWidth;
            const amplitude = history[i] || 0; // Default to 0 if undefined
            const barHeight = Math.max(1, amplitude * height * 0.8); // Ensure min height of 1px

            ctx.fillStyle = barColor;
            ctx.fillRect(x, (height - barHeight) / 2, barWidth - 1, barHeight); // -1 for spacing
        }
    }

    // --- Public API ---
    return {
        init
    };
})();

// --- DOM Ready ---
document.addEventListener('DOMContentLoaded', () => {
    if (typeof AudioRecorder?.init === 'function') {
        AudioRecorder.init();
        console.log("DOM fully loaded and parsed, AudioRecorder.init() called.");
    } else {
        console.error("AudioRecorder or its init function is not available on DOMContentLoaded.");
        const errDisp = document.getElementById('errorMessage');
        if (errDisp) {
             errDisp.textContent = "Critical Error: Recorder module failed to load.";
             errDisp.style.display = 'block';
        }
    }
});