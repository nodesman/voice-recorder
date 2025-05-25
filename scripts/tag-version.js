#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get version from package.json
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
let version;

try {
    const packageJsonContents = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContents);
    version = packageJson.version;
} catch (error) {
    console.error(`Error reading or parsing package.json at ${packageJsonPath}:`, error);
    process.exit(1);
}

if (!version) {
    console.error('Error: Version could not be read from package.json.');
    process.exit(1);
}

const tagName = `v${version}`;
const tagMessage = `Version ${version}`;

try {
    console.log(`Attempting to create Git tag: ${tagName} with message: "${tagMessage}"`);
    // Check if inside a Git repository and if git is available
    try {
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    } catch (gitCheckError) {
        console.error('Error: Not inside a Git repository or Git command not found.');
        process.exit(1);
    }

    // Create an annotated tag
    execSync(`git tag -a ${tagName} -m "${tagMessage}"`, { stdio: 'inherit' });
    console.log(`Successfully created Git tag: ${tagName}`);
    console.log(`\nTo push this tag to the remote repository, run:`);
    console.log(`  git push origin ${tagName}`);
    console.log(`Or to push all tags:`);
    console.log(`  git push --tags`);

} catch (error) {
    // Check if the error is because the tag already exists
    if (error.stderr && error.stderr.toString().includes('already exists')) {
        console.warn(`Warning: Tag ${tagName} already exists. No new tag created.`);
        // Exit with 0 as this might not be considered a failure in all workflows
        process.exit(0);
    } else {
        console.error(`Error creating Git tag ${tagName}:`);
        if (error.stderr) {
            console.error(error.stderr.toString());
        } else {
            console.error(error.message);
        }
        process.exit(1);
    }
}