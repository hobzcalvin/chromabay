#!/usr/bin/env python3
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
import hashlib
from pathlib import Path

# Load private key and derive public key
with open('keys/esp32-signing-private.pem', 'rb') as f:
    private_key = serialization.load_pem_private_key(f.read(), password=None)
public_key = private_key.public_key()

# Load firmware and signature
firmware_data = Path('downloaded_firmware.bin').read_bytes()
signature_data = Path('downloaded_signature.sig').read_bytes()

print(f"Firmware size: {len(firmware_data)} bytes")
print(f"Signature size: {len(signature_data)} bytes")

# Calculate hash
firmware_hash = hashlib.sha256(firmware_data).digest()
print(f"Firmware hash: {firmware_hash.hex()}")

# Convert raw signature back to DER format for verification
r_bytes = signature_data[:32]
s_bytes = signature_data[32:]
r = int.from_bytes(r_bytes, 'big')
s = int.from_bytes(s_bytes, 'big')

print(f"r: {r:064x}")
print(f"s: {s:064x}")

der_signature = encode_dss_signature(r, s)

# Verify signature
try:
    public_key.verify(der_signature, firmware_hash, ec.ECDSA(hashes.SHA256()))
    print('✅ Signature verification PASSED')
except Exception as e:
    print(f'❌ Signature verification FAILED: {e}') 