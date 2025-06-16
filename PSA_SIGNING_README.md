# PSA Crypto Firmware Signing

This project now uses **PSA Crypto API** for both firmware signing and verification, ensuring complete cryptographic compatibility between the build process and ESP32 device.

## 🔧 Problem Solved

Previously, the system used Python's `cryptography` library for signing and PSA Crypto for verification. This caused incompatibility issues where:
- ✅ Python could verify its own signatures
- ✅ PSA could verify its own signatures  
- ❌ **PSA could NOT verify Python signatures** (error -149)

## ✅ Solution: PSA Everywhere

Now both signing and verification use PSA Crypto API:
- **GitHub Actions**: Uses C-based PSA signing tool
- **ESP32 Device**: Uses PSA crypto for verification
- **Result**: Complete compatibility and working signature verification

## 🛠 Components

### 1. PSA Signing Tool (`psa_sign_firmware.c`)
C program that signs firmware using PSA crypto:
```bash
./psa_sign_firmware firmware.bin private_key.raw firmware.sig
```

**Features:**
- Uses PSA Crypto API for signing
- Accepts raw 32-byte private keys
- Produces 64-byte signatures (r||s format)
- Same crypto library as ESP32 verification

### 2. Key Conversion Tool (`convert_key_to_raw.py`)
Converts PEM private keys to raw format for PSA:
```bash
python3 convert_key_to_raw.py input.pem output.raw
```

### 3. Updated GitHub Actions
Workflow now:
1. Installs mbedTLS development libraries
2. Converts PEM key to raw format
3. Compiles PSA signing tool
4. Signs firmware with PSA crypto
5. Deploys PSA-compatible signatures

### 4. ESP32 Firmware
Already uses PSA crypto for verification (no changes needed).

## 📋 Usage

### Local Development
```bash
# Install dependencies
make install_deps

# Build all tools
make psa_tools

# Test the complete workflow
make test_psa_workflow
```

### Manual Signing
```bash
# Convert PEM key to raw format
python3 convert_key_to_raw.py keys/esp32-signing-private.pem private_key.raw

# Build signing tool
gcc -Wall -std=c99 psa_sign_firmware.c -lmbedcrypto -o psa_sign_firmware

# Sign firmware
./psa_sign_firmware firmware.bin private_key.raw firmware.sig
```

### Testing Verification
```bash
# Build and run end-to-end test
make test_psa_end_to_end && ./test_psa_end_to_end
```

## 🔐 Security

**Key Management:**
- Private key stored in GitHub Actions secrets
- Converted to raw format only during build
- Raw key files are cleaned up after use
- No sensitive keys stored in repository

**Signature Format:**
- ECDSA P-256 with SHA-256
- 64-byte raw format (32-byte r + 32-byte s)
- Big-endian encoding
- Compatible with PSA_ALG_ECDSA(PSA_ALG_SHA_256)

## 🚀 Deployment

The system is now fully operational:

1. **Update GitHub Secret**: Copy the private key from `keys/esp32-signing-private.pem` to the `ESP32_SIGNING_PRIVATE_KEY` secret
2. **Create Release**: Push a tag like `fwv0.0.14` to trigger signing
3. **Verify**: ESP32 devices will now successfully verify signatures

## 🧪 Testing

Several verification tools are available:

```bash
# Test PSA signing and verification
./test_psa_end_to_end

# Compare PSA vs Python signatures  
./compare_psa_python_signatures

# Test complete workflow
make test_psa_workflow
```

## 🔍 Debugging

If signature verification fails:

1. **Check Key Pair**: Ensure ESP32 public key matches signing private key
2. **Test Locally**: Use `make test_psa_workflow` to verify setup
3. **Check Logs**: ESP32 logs show detailed verification steps
4. **Verify Hash**: Ensure firmware hash calculation is identical

## 📈 Benefits

**Reliability:**
- ✅ Guaranteed compatibility between signing and verification
- ✅ Same crypto library (mbedTLS/PSA) used throughout
- ✅ Eliminates library-specific signature format differences

**Security:**
- ✅ Modern PSA Crypto API
- ✅ Consistent cryptographic implementation
- ✅ Reduced attack surface (single crypto library)

**Maintainability:**
- ✅ Simpler debugging (same library everywhere)
- ✅ Clear separation of concerns
- ✅ Well-documented workflow

The signature verification issue is now **completely resolved**! 🎉 