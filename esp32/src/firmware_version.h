#pragma once

// Firmware Version - This will be updated by the release script
// Format: esp32-vX.Y.Z
#define FIRMWARE_VERSION "esp32-v1.0.0"

// Hardware Version - Manually update this if hardware changes
// Format: esp32-hw-vX.Y
#define HARDWARE_VERSION "esp32-hw-v1.0"

// --- Firmware Signature Verification ---
// Placeholder for the public key (PEM format or raw bytes as a hex string)
// Replace this with your actual public key.
// For example, for an ECDSA P-256 public key (65 bytes uncompressed, 33 compressed, or ~DER format)
// This key will be used by the ESP32 to verify the signature of the received firmware.
#define FIRMWARE_SIGNATURE_PUBLIC_KEY "-----BEGIN PUBLIC KEY-----\\nREPLACE_WITH_YOUR_ACTUAL_PUBLIC_KEY_MATERIAL\\n-----END PUBLIC KEY-----\\n"

// Define the expected length of the firmware signature.
// For ECDSA with P-256, the signature is typically 64 bytes (two 32-byte integers, R and S).
// This might vary depending on the signature scheme and format (e.g., DER encoding).
#define FIRMWARE_SIGNATURE_LENGTH 64


// You can add other build-time constants here if needed,
// for example, a build timestamp or specific capabilities.
