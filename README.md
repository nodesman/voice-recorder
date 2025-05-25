# Electron Audio Recorder & Transcriber

An Electron-based desktop application that allows users to quickly record audio, transcribe it using OpenAI's Whisper API, copy the transcription to the clipboard, and automatically paste it into the active application.

## Features

*   **Global Shortcut**: Activate recording (or stop/cancel) from anywhere using `CmdOrCtrl+Shift+R`.
*   **Quick Recording**: Simple interface to start, confirm, or cancel recordings.
*   **Audio Visualization**: Real-time waveform display during recording.
*   **OpenAI Whisper Transcription**: High-quality audio-to-text conversion.
*   **Automatic Clipboard & Paste**: Transcribed text is automatically copied to the clipboard and pasted into the previously active window.
*   **Silence Removal**: `ffmpeg` is used to preprocess audio, removing leading/trailing silence for more efficient transcription.
*   **Error Handling & Retry**:
    *   UI feedback for processing steps (e.g., "Converting audio...", "Transcribing...").
    *   Handles API errors, with an option to retry for transient issues (e.g., network errors, rate limits).
*   **Cross-Platform (with caveats)**:
    *   Core recording and transcription work on macOS, Windows, and Linux.
    *   Automatic pasting uses platform-specific tools:
        *   **macOS**: AppleScript
        *   **Windows**: VBScript
        *   **Linux**: `xdotool` (requires installation, may have limitations on Wayland)
*   **Stealthy UI**: Small, frameless window that appears near the top-right of the screen and hides automatically after use or on blur (unless an error requires user interaction).
*   **Single Instance**: Prevents multiple copies of the app from running.
*   **Launcher Script**: Includes a `bin/launch-recorder.js` script, allowing the application to be launched (and stopped with `--stop`) from the command line, suitable for global npm installation.

## Prerequisites

Before you begin, ensure you have the following installed:

1.  **Node.js and npm**: [Download Node.js](https://nodejs.org/) (npm is included).
2.  **ffmpeg**: This is crucial for audio processing (converting to MP3 and silence removal).
    *   **macOS**: `brew install ffmpeg`
    *   **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to your system's PATH.
    *   **Linux**: `sudo apt update && sudo apt install ffmpeg` (Debian/Ubuntu) or `sudo yum install ffmpeg` (Fedora/CentOS).
3.  **OpenAI API Key**: You need an API key from OpenAI to use the Whisper transcription service.
4.  **(Linux Only) `xdotool`**: For the automatic paste functionality on Linux.
    *   `sudo apt install xdotool` (Debian/Ubuntu)
    *   `sudo yum install xdotool` (Fedora/CentOS)

## Setup and Installation

1.  **Clone the repository (if applicable) or download the source code.**
    ```bash
    # Example if you have it in a git repo
    # git clone <your-repository-url>
    # cd electron-recorder-transcriber
    ```

2.  **Install dependencies:**
    Navigate to the project directory and run:
    ```bash
    npm install
    ```
    This will install Electron, the OpenAI Node.js library, and other necessary packages.

3.  **Configure Environment Variables:**
    Create a `.env` file in the root of the project directory. Add your OpenAI API key to this file:
    ```env
    OPENAI_API_KEY=your_openai_api_key_here
    ```
    **Important**: Add `.env` to your `.gitignore` file if it's not already there to prevent committing your API key.

## Usage

1.  **Start the application:**
    ```bash
    npm start
    ```
    The application will start, but the window will be hidden initially.

2.  **Recording:**
    *   Press the global shortcut `CmdOrCtrl+Shift+R`.
    *   The recorder window will appear. It starts in an "idle" state with a microphone icon.
    *   Click the **microphone icon** to start recording.
    *   The UI will change to show:
        *   A **cancel button (X)** to stop recording without processing.
        *   A **waveform visualizer**.
        *   A **timer**.
        *   A **confirm button (checkmark)** to stop recording and proceed with transcription.
    *   Pressing the global shortcut `CmdOrCtrl+Shift+R` *while recording* will act as a **confirm** and proceed to transcription.

3.  **Processing:**
    *   After confirming, the UI will show a "Processing..." state, which may update with details like "Converting audio..." or "Transcribing...".
    *   The audio is first converted to MP3 and preprocessed by `ffmpeg`.
    *   Then, it's sent to the OpenAI Whisper API for transcription.

4.  **Output:**
    *   If successful, the transcribed text is copied to your clipboard.
    *   The application will then attempt to paste the text into the window that was active *before* the recorder was triggered.
    *   The recorder window will automatically hide.

5.  **Error Handling:**
    *   If transcription fails due to a retryable error (e.g., network issue, API rate limit), an error message will appear with a **retry button** and a **cancel button**.
        *   **Retry**: Attempts transcription again with the same audio.
        *   **Cancel**: Discards the recording and hides the window.
    *   Pressing the global shortcut `CmdOrCtrl+Shift+R` *while in an error state* will act as a **cancel**.
    *   For non-retryable errors (e.g., invalid API key, permanent API issue), an error message is shown. You can cancel to hide the window.

6.  **Stopping the Application:**
    *   If you installed the package globally (see "Global Installation" below) or are running it via the launcher, you can use:
        ```bash
        audio-recorder --stop
        ```
    *   Otherwise, you'll need to find the process and terminate it manually if it's running in the background (e.g., via Task Manager on Windows, Activity Monitor on macOS, or `kill` command on Linux).

## Global Installation (Optional)

If you want to run the `audio-recorder` command from anywhere, you can link the package globally during development or publish it and install it globally.

1.  **Link for development:**
    In the project directory:
    ```bash
    npm link
    ```
    Now you can use `audio-recorder` to launch and `audio-recorder --stop` to quit.

2.  **Uninstall link:**
    ```bash
    npm unlink electron-recorder-transcriber # Or your package name
    ```

## Building for Distribution

This project uses `electron-builder` (listed in `devDependencies`). You can add build scripts to your `package.json`. For example:

```json
// package.json
"scripts": {
  "start": "electron .",
  "dist": "electron-builder",
  // ... other scripts
}
```

Then run:
```bash
npm run dist
```
This will create distributable packages (e.g., `.dmg` for macOS, `.exe` for Windows, `.AppImage` for Linux) in a `dist` folder. Refer to the [electron-builder documentation](https://www.electron.build/) for configuration options.

## Scripts

*   `npm start`: Starts the Electron application in development mode.
*   `npm run tag-version`: A utility script (in `scripts/tag-version.js`) to create a Git tag based on the `version` in `package.json`. This is useful for versioning releases.

## Project Structure

```
.
├── bin/
│   └── launch-recorder.js    # CLI launcher script
├── node_modules/             # Dependencies
├── scripts/
│   └── tag-version.js        # Script to tag versions in git
├── .env                      # Local environment variables (API KEY - IGNORED BY GIT)
├── .env.example              # Example environment file
├── .gitignore
├── .kaiignore                # Kai AI assistant specific ignore
├── index.html                # Main HTML file for the renderer window
├── main.js                   # Electron main process script
├── package.json
├── package-lock.json
├── preload.js                # Electron preload script for secure IPC
├── README.md                 # This file
└── style.css                 # Styles for the recorder UI
└── renderer.js               # Electron renderer process script (UI logic)
```

## Platform-Specific Paste Functionality

The automatic paste feature relies on external command-line tools:

*   **macOS**: Uses `osascript` to send `Cmd+V`. This is generally reliable and built-in.
*   **Windows**: Uses a temporary VBScript file executed by `cscript.exe` to send `Ctrl+V`. This is a common workaround for simulating key presses.
*   **Linux**: Uses `xdotool key --clearmodifiers ctrl+v`.
    *   `xdotool` must be installed separately.
    *   **Wayland**: `xdotool` primarily works with X11. Its compatibility with Wayland display servers can be limited or require specific configuration. Pasting may not work reliably on Wayland.

If a paste command fails, the transcribed text will still be in your clipboard.

## Troubleshooting

*   **"OpenAI API Key is missing" Error**: Ensure your `.env` file exists in the project root and contains your valid `OPENAI_API_KEY`.
*   **"ffmpeg command not found" Error (in logs or UI)**:
    *   Verify `ffmpeg` is installed correctly.
    *   Ensure the directory containing `ffmpeg.exe` (Windows) or the `ffmpeg` binary (macOS/Linux) is in your system's PATH environment variable. Restart your terminal or system after updating PATH.
*   **"xdotool command not found" Error (Linux)**: Install `xdotool` using your package manager (e.g., `sudo apt install xdotool`).
*   **Shortcut `CmdOrCtrl+Shift+R` doesn't work**:
    *   Another application might be using the same global shortcut. Check your system's shortcut settings or other running applications.
    *   The application logs (console output when running `npm start`) may indicate if shortcut registration failed.
*   **Audio recording fails or "No microphone found"**:
    *   Ensure your microphone is connected and enabled in your system settings.
    *   Grant microphone permission to the application if prompted by your OS.
*   **Transcription is empty or poor quality**:
    *   Check microphone input levels.
    *   Speak clearly and minimize background noise.
    *   The silence removal might be too aggressive if the speech is very quiet or starts/ends abruptly. This can be tweaked in `main.js` (`ffmpegCommand` within `transcribe-audio` handler).
*   **Automatic paste doesn't work**:
    *   The transcribed text should still be on your clipboard.
    *   On Linux, ensure `xdotool` is installed and you are not on a Wayland session where `xdotool` might have issues.
    *   The application attempts to paste into the *previously focused* window. If focus changed unexpectedly, it might paste elsewhere or not at all.

## License

ISC License. See `package.json`.

## Acknowledgements

*   OpenAI for the Whisper API.
*   Electron and Node.js communities.