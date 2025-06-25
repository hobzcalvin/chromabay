#!/usr/bin/env node

import { execSync } from 'child_process';
import { platform } from 'os';

function runCommand(command, options = {}) {
    try {
        const result = execSync(command, { 
            stdio: 'pipe', 
            encoding: 'utf8',
            ...options 
        });
        return { success: true, output: result };
    } catch (error) {
        return { success: false, error: error.message, output: error.stdout || '' };
    }
}

function checkEmscripten() {
    // Check if emcc is available in PATH
    const emccCheck = runCommand('which emcc');
    if (emccCheck.success) {
        console.log('✅ Emscripten already available in PATH');
        return true;
    }
    return false;
}

function setupEmscriptenMacOS() {
    console.log('🍺 Installing Emscripten via Homebrew...');
    
    // Check if Homebrew is installed
    const brewCheck = runCommand('which brew');
    if (!brewCheck.success) {
        console.error('❌ Homebrew not found. Please install Homebrew first:');
        console.error('   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
        process.exit(1);
    }

    // Install emscripten via Homebrew
    const installResult = runCommand('brew install emscripten');
    if (!installResult.success) {
        console.error('❌ Failed to install Emscripten via Homebrew:', installResult.error);
        process.exit(1);
    }

    console.log('✅ Emscripten installed successfully via Homebrew!');
}

function setupEmscriptenLinux() {
    console.log('📦 Setting up Emscripten on Linux...');
    console.log('Please install Emscripten using one of these methods:');
    console.log('');
    console.log('1. Package manager (recommended):');
    console.log('   # Ubuntu/Debian:');
    console.log('   sudo apt-get install emscripten');
    console.log('   # Arch Linux:');
    console.log('   sudo pacman -S emscripten');
    console.log('');
    console.log('2. Or use the official emsdk:');
    console.log('   git clone https://github.com/emscripten-core/emsdk.git');
    console.log('   cd emsdk && ./emsdk install latest && ./emsdk activate latest');
    console.log('   source ./emsdk_env.sh');
    console.log('');
    process.exit(1);
}

function setupEmscriptenWindows() {
    console.log('🪟 Setting up Emscripten on Windows...');
    console.log('Please install Emscripten using one of these methods:');
    console.log('');
    console.log('1. Chocolatey (recommended):');
    console.log('   choco install emscripten');
    console.log('');
    console.log('2. Or use the official emsdk:');
    console.log('   git clone https://github.com/emscripten-core/emsdk.git');
    console.log('   cd emsdk && emsdk install latest && emsdk activate latest');
    console.log('   emsdk_env.bat');
    console.log('');
    process.exit(1);
}

function setupEmscripten() {
    const currentPlatform = platform();
    
    switch (currentPlatform) {
        case 'darwin':
            setupEmscriptenMacOS();
            break;
        case 'linux':
            setupEmscriptenLinux();
            break;
        case 'win32':
            setupEmscriptenWindows();
            break;
        default:
            console.error(`❌ Unsupported platform: ${currentPlatform}`);
            console.error('Please install Emscripten manually and ensure emcc is in your PATH');
            process.exit(1);
    }
}

function main() {
    if (!checkEmscripten()) {
        setupEmscripten();
    }
}

main(); 