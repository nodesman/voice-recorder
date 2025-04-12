#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Find the actual installation directory of the package.
const packageRootDir = path.resolve(__dirname, '..');
const electronExecutable = path.join(packageRootDir, 'node_modules', '.bin', 'electron');

// Check if electron executable exists where expected
if (!fs.existsSync(electronExecutable)) {
    console.error(`Error: Electron executable not found at ${electronExecutable}`);
    console.error('Please ensure you have run "npm install" in the package directory:', packageRootDir);
    process.exit(1);
}

// --- START MODIFICATION ---
// Get arguments passed to this script (e.g., --stop)
const scriptArgs = process.argv.slice(2);
console.log(`Launcher script received args: ${scriptArgs.join(' ')}`);

// Combine the Electron entry point '.' with the script arguments
const electronArgs = ['.', ...scriptArgs];
// --- END MODIFICATION ---

console.log(`Launching Electron app from: ${packageRootDir} with args: ${electronArgs.join(' ')}`);

// Spawn Electron, pointing it to the package root directory and passing args
const appProcess = spawn(electronExecutable, electronArgs, { // Pass electronArgs here
  cwd: packageRootDir, // IMPORTANT: Set the working directory for Electron
  detached: true,      // Allows the parent script to exit while Electron runs
  stdio: 'ignore',     // Ignore stdin/stdout/stderr for the basic launch
});

// Unreference the child process so this script can exit cleanly
appProcess.unref();

// If the argument was --stop, the launcher still exits quickly.
// The *second* Electron instance (that gets spawned above) will handle signaling
// the *first* instance and then quit itself because it can't get the lock.
console.log('Electron process spawned/triggered. The launcher script will now exit.');
process.exit(0); // Exit the launcher script successfully