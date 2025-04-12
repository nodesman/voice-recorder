#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Find the actual installation directory of the package.
// __dirname when run via npm link points to the bin directory *inside* the linked package.
// We need to go up one level to get the package root.
const packageRootDir = path.resolve(__dirname, '..');
const electronExecutable = path.join(packageRootDir, 'node_modules', '.bin', 'electron');

// Check if electron executable exists where expected
if (!fs.existsSync(electronExecutable)) {
    console.error(`Error: Electron executable not found at ${electronExecutable}`);
    console.error('Please ensure you have run "npm install" in the package directory:', packageRootDir);
    process.exit(1);
}

console.log(`Launching Electron app from: ${packageRootDir}`);

// Spawn Electron, pointing it to the package root directory
// We use detached mode so it *can* run independently, although nohup handles persistence.
const appProcess = spawn(electronExecutable, ['.'], {
  cwd: packageRootDir, // IMPORTANT: Set the working directory for Electron
  detached: true,      // Allows the parent script to exit while Electron runs
  stdio: 'ignore',     // Ignore stdin/stdout/stderr for the basic launch
});

// Unreference the child process so this script can exit cleanly
// without waiting for the Electron app to close.
appProcess.unref();

console.log('Electron process spawned. The launcher script will now exit.');
process.exit(0); // Exit the launcher script successfully