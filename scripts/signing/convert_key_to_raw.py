#!/usr/bin/env python3
"""
Convert PEM private key to raw 32-byte format for PSA signing
"""

import sys
from cryptography.hazmat.primitives import serialization

def main():
    if len(sys.argv) != 3:
        print("Usage: python3 convert_key_to_raw.py <input.pem> <output.raw>")
        print("Converts ECDSA P-256 private key from PEM to raw 32-byte format")
        return 1
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        # Load PEM private key
        with open(input_file, 'rb') as f:
            private_key = serialization.load_pem_private_key(f.read(), password=None)
        
        # Extract private key value (d parameter)
        private_numbers = private_key.private_numbers()
        private_value = private_numbers.private_value
        
        # Convert to 32-byte big-endian format
        private_key_bytes = private_value.to_bytes(32, byteorder='big')
        
        # Write raw key
        with open(output_file, 'wb') as f:
            f.write(private_key_bytes)
        
        print(f"✅ Converted {input_file} -> {output_file}")
        print(f"📝 Private key: {private_key_bytes.hex()}")
        print(f"📏 Size: {len(private_key_bytes)} bytes")
        
        return 0
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return 1

if __name__ == '__main__':
    sys.exit(main()) 