// renderer.js

// Strict mode helps catch common coding errors
"use strict";

// Check if the preload script exposed the API - crucial first step
if (typeof window.electronAPI?.transcribeAudio !== 'function') {
    console.error("Electron API (electronAPI.transcribeAudio) not found! Check preload script and contextIsolation settings.");
    // Display a persistent error to the user in the UI is highly recommended here.
    // For example, disable the mic button and show a message.
    const micButton = document.getElementById('micButton');
    if (micButton) {
        micButton.disabled = true;
        micButton.style.cursor = 'not-allowed';
        micButton.style.fill = '#666'; // Dim the icon
    }
    alert("Critical Error: Cannot communicate with the main process. Recording and transcription are disabled. Please check the application setup or restart.");
}

const AudioRecorder = (() => {
    // --- DOM Elements ---
    let recorderContainer;
    let micButton;
    let cancelButton;
    let confirmButton;
    let recordingCanvas;
    let processingCanvas;
    let timerDisplay;
    let totalDurationDisplay;
    let transcriptionDisplay;

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
    let transcriptionTimeoutId = null; // To hide transcription text later

    const WAVEFORM_BAR_COUNT = 60;
    let waveformHistory = new Array(WAVEFORM_BAR_COUNT).fill(0);
    let currentMimeType = ''; // Store the mime type used

    // --- Initialization ---
    function init() {
        recorderContainer = document.querySelector('.audio-recorder');
        micButton = document.getElementById('micButton');
        cancelButton = document.getElementById('cancelButton');
        confirmButton = document.getElementById('confirmButton');
        recordingCanvas = document.getElementById('recordingWaveformCanvas');
        processingCanvas = document.querySelector('.processing-bar .waveform-canvas');
        timerDisplay = document.getElementById('timerDisplay');
        totalDurationDisplay = document.getElementById('totalDurationDisplay');
        transcriptionDisplay = document.getElementById('transcriptionDisplay');

        if (!recorderContainer || !micButton || !cancelButton || !confirmButton || !recordingCanvas || !processingCanvas || !timerDisplay || !totalDurationDisplay || !transcriptionDisplay) {
            console.error("Recorder UI elements not found! Check IDs and structure in index.html.");
            return; // Stop initialization if elements are missing
        }

        // Check again if API is available before adding listeners that depend on it
        if (typeof window.electronAPI?.transcribeAudio === 'function') {
            micButton.addEventListener('click', startRecording);
            cancelButton.addEventListener('click', () => stopRecording(false)); // Save=false
            confirmButton.addEventListener('click', () => stopRecording(true)); // Save=true
            console.log("Audio Recorder Initialized and listeners added.");
        } else {
            console.error("Initialization skipped: electronAPI not available.");
             // Maybe add a visual indicator that it's disabled
             recorderContainer.style.opacity = '0.5';
             recorderContainer.title = 'Recorder disabled due to internal error.';
        }

        // Set initial state based on HTML attribute
        setState(recorderContainer.dataset.state || 'idle');
    }

    // --- State Management ---
    function setState(newState) {
        if (!recorderContainer) return; // Guard against missing container

        // Clear transcription hide timeout if switching state
        if (transcriptionTimeoutId) {
            clearTimeout(transcriptionTimeoutId);
            transcriptionTimeoutId = null;
        }
        recorderContainer.classList.remove('show-transcription'); // Remove class when state changes

        recorderContainer.dataset.state = newState;
        isRecording = (newState === 'recording');

        // Clear transcription text & styling when returning to idle
        if (newState === 'idle') {
            transcriptionDisplay.textContent = '';
            transcriptionDisplay.classList.remove('error', 'success'); // 'success' isn't used yet but good practice
        }
        // Set initial text for processing state
        else if (newState === 'processing') {
            transcriptionDisplay.textContent = 'Preparing audio...';
            transcriptionDisplay.classList.remove('error', 'success');
        }

        console.log("State changed to:", newState);
    }

    // --- Recording Logic ---
    async function startRecording() {
        if (isRecording || typeof window.electronAPI?.transcribeAudio !== 'function') {
            console.warn("Cannot start recording. Already recording or API unavailable.");
            return;
        }
        console.log("Attempting to start recording...");

        // Reset UI elements related to previous transcriptions
        transcriptionDisplay.textContent = '';
        transcriptionDisplay.classList.remove('error', 'success');
        recorderContainer.classList.remove('show-transcription');
        if (transcriptionTimeoutId) clearTimeout(transcriptionTimeoutId);

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

            // Setup MediaRecorder - Prioritize formats good for Whisper
            const mimeTypes = [
                'audio/webm;codecs=opus',
                'audio/ogg;codecs=opus',
                'audio/webm', // Fallback webm
                'audio/mp4',  // Often supported, check Whisper compatibility
                // 'audio/wav' // Usually large, less ideal for upload
            ];
            currentMimeType = ''; // Reset
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
            mediaRecorder.onstop = handleStop; // This now triggers the processing logic

            // Start
            mediaRecorder.start(100); // Trigger data available roughly every 100ms
            recordingStartTime = Date.now();
            setState('recording');
            startTimer();
            visualize(); // Start waveform animation

            console.log("Recording started. State:", mediaRecorder.state, "MIME:", mediaRecorder.mimeType);

        } catch (err) {
            console.error("Error starting recording:", err);
            // Provide more specific feedback if possible
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                 alert("Microphone access was denied. Please allow microphone access in your browser/system settings and try again.");
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                 alert("No microphone found. Please ensure a microphone is connected and enabled.");
            } else {
                 alert(`Could not start recording: ${err.message}`);
            }
            cleanUpAudio(); // Clean up resources
            setState('idle');   // Return to idle state
        }
    }

    function stopRecording(shouldSaveAndProcess) {
        console.log(`Stopping recording. Save intent: ${shouldSaveAndProcess}`);
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            console.log("Recorder not active or already stopped.");
            // Ensure UI cleanup if stop is called unexpectedly
            if (recorderContainer?.dataset.state !== 'idle') {
                cleanUpAudio();
                stopTimer();
                stopVisualization();
                setState('idle');
            }
            return;
        }

        // Attach the save flag directly to the recorder instance for handleStop to read
        mediaRecorder.shouldSaveAndProcess = shouldSaveAndProcess;

        // Request the recorder to stop. The actual processing happens in the 'onstop' event handler.
        try {
            mediaRecorder.stop();
        } catch (error) {
            console.error("Error calling mediaRecorder.stop():", error);
            // Force cleanup and idle state if stopping fails
            cleanUpAudio();
            setState('idle');
        }

        // Stop visual feedback immediately
        stopVisualization();
        stopTimer(); // Stop timer updates
    }

    function handleDataAvailable(event) {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    }

    // handleStop: Triggered automatically when mediaRecorder.stop() finishes
    async function handleStop() {
        console.log("MediaRecorder 'stop' event triggered.");
        // Retrieve the flag set in stopRecording()
        const shouldSaveAndProcess = !!mediaRecorder?.shouldSaveAndProcess;
        const finalDuration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;

        // Clean up the flag from the instance
        if (mediaRecorder) delete mediaRecorder.shouldSaveAndProcess;

        if (shouldSaveAndProcess && recordedChunks.length > 0) {
            setState('processing'); // Switch to processing UI
            totalDurationDisplay.textContent = formatTime(finalDuration);
            drawWaveform(processingCanvas, waveformHistory); // Draw final static waveform

            // Combine chunks into a single Blob
            const finalBlob = new Blob(recordedChunks, { type: currentMimeType || 'audio/webm' });
            console.log(`Final Blob created: Size=${finalBlob.size}, Type=${finalBlob.type}`);

            // --- Convert Blob to Uint8Array for IPC ---
            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                const audioDataUint8Array = new Uint8Array(arrayBuffer);

                if (audioDataUint8Array.length === 0) {
                     throw new Error("Converted audio data is empty.");
                }

                console.log(`Renderer: Sending ${audioDataUint8Array.length} bytes to main process for transcription.`);
                transcriptionDisplay.textContent = "Uploading & Transcribing...";
                recorderContainer.classList.add('show-transcription'); // Make text visible

                // --- Send to Main Process via Preload ---
                // Ensure the API is still available (paranoid check)
                if (typeof window.electronAPI?.transcribeAudio === 'function') {
                    const result = await window.electronAPI.transcribeAudio(audioDataUint8Array);

                    // Handle Response
                    if (recorderContainer.dataset.state !== 'processing') {
                        console.log("Renderer: State changed before transcription result arrived. Ignoring result.");
                         // Cleanup happens below anyway
                    } else if (result?.error) {
                        console.error("Renderer: Transcription Error from main:", result.error);
                        transcriptionDisplay.textContent = `Error: ${result.error}`;
                        transcriptionDisplay.classList.add('error');
                    } else if (result?.text !== undefined) {
                        console.log("Renderer: Transcription Received:", result.text);
                        // Display transcription or a placeholder if empty
                        transcriptionDisplay.textContent = result.text.trim() || "[No speech detected]";
                        transcriptionDisplay.classList.remove('error'); // Ensure error style is removed
                        // transcriptionDisplay.classList.add('success'); // Optional success style
                    } else {
                        console.error("Renderer: Invalid response structure from main process:", result);
                        transcriptionDisplay.textContent = "Error: Invalid response received.";
                        transcriptionDisplay.classList.add('error');
                    }
                } else {
                    console.error("Renderer: electronAPI.transcribeAudio became unavailable!");
                    transcriptionDisplay.textContent = "Error: Communication failed.";
                    transcriptionDisplay.classList.add('error');
                }

            } catch (error) {
                console.error("Renderer: Error processing Blob or sending audio:", error);
                transcriptionDisplay.textContent = `Error: ${error.message}`;
                transcriptionDisplay.classList.add('error');
                 // Ensure text is visible even on error
                if (recorderContainer.dataset.state === 'processing'){
                     recorderContainer.classList.add('show-transcription');
                }
            } finally {
                 // Regardless of success or failure, eventually return to idle.
                 // Keep showing the result/error for a few seconds.
                 if (recorderContainer.dataset.state === 'processing') {
                    transcriptionTimeoutId = setTimeout(() => {
                         // Check state again, user might have started new recording
                         if (recorderContainer.dataset.state === 'processing') {
                              setState('idle');
                         }
                         recorderContainer.classList.remove('show-transcription'); // Hide text area
                         transcriptionTimeoutId = null;
                    }, 5000); // Show result/error for 5 seconds
                 } else {
                     // If state already changed, just ensure cleanup
                     cleanUpAudio();
                     recordedChunks = [];
                 }
            }

        } else {
            // If recording was cancelled or empty
            console.log("Recording cancelled or no data recorded.");
            setState('idle'); // Go back to idle
            // Cleanup audio resources immediately if cancelled
            cleanUpAudio();
            recordedChunks = [];
        }

        // Final cleanup check (especially if processing wasn't entered)
        if (recorderContainer.dataset.state !== 'processing') {
             cleanUpAudio();
             recordedChunks = [];
        }
    }


    // --- Cleanup ---
    function cleanUpAudio() {
        console.log("Cleaning up audio resources...");
        if (isRecording) {
             console.warn("Cleanup called while still in recording state? Forcing stop.");
             // Attempt to stop tracks if somehow still active
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
            console.log("MediaStream tracks stopped.");
        }
        if (sourceNode) {
            sourceNode.disconnect();
            sourceNode = null;
        }
        if (analyserNode) {
            analyserNode.disconnect(); // Important: disconnect analyser too
            analyserNode = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().then(() => {
                console.log("AudioContext closed.");
            }).catch(e => console.warn("Error closing AudioContext:", e));
            audioContext = null;
        }
        // Detach handlers to prevent potential memory leaks
        if (mediaRecorder) {
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            mediaRecorder = null;
            console.log("MediaRecorder instance released.");
        }

        // Reset chunks just in case
        recordedChunks = [];
        console.log("Audio cleanup complete.");
    }

    // --- Visualization ---
    function visualize() {
        if (!analyserNode || !isRecording || recorderContainer?.dataset.state !== 'recording') {
            stopVisualization();
            return;
        }

        const bufferLength = analyserNode.frequencyBinCount; // e.g., 128
        const dataArray = new Uint8Array(bufferLength);
        analyserNode.getByteFrequencyData(dataArray); // Fills dataArray

        // Simple averaging for amplitude - adjust calculation if needed
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
        }
        const average = bufferLength > 0 ? sum / bufferLength : 0;
        // Normalize amplitude (0-255 range -> 0.0-1.0+) and clamp
        const normalizedAmplitude = Math.min(1.0, Math.max(0, (average / 128.0) * 1.5)); // Amplify slightly

        // Update waveform history (FIFO buffer)
        waveformHistory.push(normalizedAmplitude);
        if (waveformHistory.length > WAVEFORM_BAR_COUNT) {
            waveformHistory.shift(); // Remove oldest bar
        }

        drawWaveform(recordingCanvas, waveformHistory); // Draw the current waveform

        // Request next frame
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

    // Generic draw function used by both recording and processing states
    function drawWaveform(canvas, historyData) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const centerY = height / 2;
        const numBars = historyData.length;
        const barWidth = numBars > 0 ? width / numBars : width; // Prevent division by zero

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'; // Slightly transparent white
        ctx.lineWidth = Math.max(1, barWidth * 0.7); // Adjust thickness relative to width
        ctx.lineCap = 'round';

        ctx.beginPath();
        for (let i = 0; i < numBars; i++) {
            // Ensure amplitude is at least a small positive value for visibility
            const amplitude = Math.max(historyData[i] || 0, 0.01);
            // Scale bar height, ensure it's within canvas bounds
            const barHeight = Math.min(height, Math.max(1, amplitude * height * 0.9)); // Ensure min height of 1px
            const x = i * barWidth + barWidth / 2; // Center line in the bar space
            const y1 = centerY - barHeight / 2;
            const y2 = centerY + barHeight / 2;

            ctx.moveTo(x, y1);
            ctx.lineTo(x, y2);
        }
        ctx.stroke(); // Draw all lines at once
    }

    // --- Timer ---
    function startTimer() {
        if (timerIntervalId) clearInterval(timerIntervalId);
        timerDisplay.textContent = "0:00";
        if (!recordingStartTime) recordingStartTime = Date.now(); // Ensure start time is set

        timerIntervalId = setInterval(() => {
            if (!isRecording || recorderContainer?.dataset.state !== 'recording' || !recordingStartTime) {
                stopTimer(); // Stop if state changes or start time is lost
                return;
            }
            const elapsedSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
            timerDisplay.textContent = formatTime(elapsedSeconds);
        }, 1000); // Update every second
    }

    function stopTimer() {
        if (timerIntervalId) {
            clearInterval(timerIntervalId);
            timerIntervalId = null;
        }
        // Reset start time for next recording session
        recordingStartTime = null;
    }

    // Helper to format seconds into MM:SS
    function formatTime(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // --- Public API ---
    // Expose only the init function to the outside world
    return {
        init: init
    };
})();

// --- Initialize the component when the DOM is fully loaded ---
// Use DOMContentLoaded for faster initialization than window.onload
document.addEventListener('DOMContentLoaded', AudioRecorder.init);