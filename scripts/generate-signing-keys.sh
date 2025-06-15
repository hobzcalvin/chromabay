#!/bin/bash
set -e

echo "🔐 Generating ESP32 Firmware Signing Keys..."

# Create keys directory if it doesn't exist
mkdir -p keys

# Generate ECDSA P-256 private key
echo "📝 Generating private key..."
openssl ecparam -genkey -name prime256v1 -noout -out keys/esp32-signing-private.pem

# Extract public key  
echo "📝 Extracting public key..."
openssl ec -in keys/esp32-signing-private.pem -pubout -out keys/esp32-signing-public.pem

# Extract public key in raw uncompressed format (65 bytes: 0x04 + 32-byte X + 32-byte Y)
echo "📝 Extracting raw public key for embedding..."
openssl ec -in keys/esp32-signing-private.pem -noout -text | \
    grep -A 5 "pub:" | tail -n +2 | \
    sed 's/[[:space:]]//g' | sed 's/://g' | \
    tr -d '\n' > keys/esp32-public-key-hex.txt

# Convert to C array format for easy embedding
echo "📝 Creating C array format..."
python3 -c "
import sys
hex_str = open('keys/esp32-public-key-hex.txt').read().strip()
# Remove the 0x04 prefix (uncompressed point indicator) to get 64 bytes
if hex_str.startswith('04'):
    hex_str = hex_str[2:]
    
if len(hex_str) != 128:  # 64 bytes * 2 hex chars
    print(f'Error: Expected 128 hex chars (64 bytes), got {len(hex_str)}')
    sys.exit(1)

# Write as C array
with open('keys/esp32-public-key-c-array.txt', 'w') as f:
    f.write('static const uint8_t FIRMWARE_PUBLIC_KEY[64] = {\n')
    for i in range(0, 128, 32):  # 16 bytes per line
        line_bytes = []
        for j in range(0, 32, 2):
            if i + j < 128:
                byte_val = hex_str[i + j:i + j + 2]
                line_bytes.append(f'0x{byte_val}')
        f.write('    ' + ', '.join(line_bytes))
        if i + 32 < 128:
            f.write(',')
        f.write('\n')
    f.write('};')

print('C array written to keys/esp32-public-key-c-array.txt')
"

echo "✅ Keys generated successfully:"
echo "   Private key: keys/esp32-signing-private.pem (KEEP SECRET!)"
echo "   Public key:  keys/esp32-signing-public.pem" 
echo "   Public hex:  keys/esp32-public-key-hex.txt"
echo "   C array:     keys/esp32-public-key-c-array.txt"
echo ""
echo "🚨 SECURITY NOTICE:"
echo "   - Add keys/ to .gitignore immediately"
echo "   - Store private key in GitHub Actions secrets"
echo "   - Update firmware_version.h with the public key"
echo "   - Delete private key from local machine after setup"
echo ""
echo "📋 Next steps:"
echo "   1. Copy contents of keys/esp32-public-key-c-array.txt"
echo "   2. Replace FIRMWARE_PUBLIC_KEY array in esp32/src/firmware_version.h"
echo "   3. Add private key to GitHub Actions secrets as ESP32_SIGNING_PRIVATE_KEY" 