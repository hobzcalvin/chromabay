#!/usr/bin/env python3
"""
ESP32 Firmware Signing Tool
Signs firmware binaries with ECDSA P-256 for secure OTA updates
"""

import sys
import hashlib
import argparse
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

def sign_firmware(firmware_path: Path, private_key_path: Path, output_sig_path: Path) -> bool:
    """Sign firmware binary and output signature file"""
    
    try:
        # Read firmware binary
        firmware_data = firmware_path.read_bytes()
        print(f"📦 Firmware size: {len(firmware_data)} bytes")
        
        # Load private key
        with open(private_key_path, 'rb') as f:
            private_key = serialization.load_pem_private_key(f.read(), password=None)
        
        # Calculate SHA-256 hash of firmware
        firmware_hash = hashlib.sha256(firmware_data).digest()
        print(f"🔍 Firmware SHA-256: {firmware_hash.hex()}")
        
        # Sign the hash with ECDSA
        signature = private_key.sign(firmware_hash, ec.ECDSA(hashes.SHA256()))
        
        # Extract r and s components (64 bytes total for P-256)
        # ESP32 expects raw r||s format, not DER encoding
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
        r, s = decode_dss_signature(signature)
        
        # Convert to 32-byte big-endian format each
        r_bytes = r.to_bytes(32, byteorder='big')
        s_bytes = s.to_bytes(32, byteorder='big')
        raw_signature = r_bytes + s_bytes
        
        # Write signature file
        output_sig_path.write_bytes(raw_signature)
        
        print(f"✅ Signature written to: {output_sig_path}")
        print(f"📝 Signature length: {len(raw_signature)} bytes")
        print(f"🔐 Signature (hex): {raw_signature.hex()}")
        
        return True
        
    except Exception as e:
        print(f"❌ Signing failed: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Sign ESP32 firmware for secure OTA')
    parser.add_argument('firmware', type=Path, help='Path to firmware binary')
    parser.add_argument('--private-key', type=Path, required=True, help='Path to private key PEM file')
    parser.add_argument('--output', type=Path, help='Output signature file (default: firmware.sig)')
    
    args = parser.parse_args()
    
    if not args.firmware.exists():
        print(f"❌ Firmware file not found: {args.firmware}")
        return 1
        
    if not args.private_key.exists():
        print(f"❌ Private key not found: {args.private_key}")
        return 1
    
    output_sig = args.output or args.firmware.with_suffix('.sig')
    
    print(f"🔐 ESP32 Firmware Signing")
    print(f"   Firmware: {args.firmware}")
    print(f"   Private Key: {args.private_key}")
    print(f"   Output: {output_sig}")
    print()
    
    if sign_firmware(args.firmware, args.private_key, output_sig):
        return 0
    else:
        return 1

if __name__ == '__main__':
    sys.exit(main()) 