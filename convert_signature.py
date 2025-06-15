#!/usr/bin/env python3

import sys

# Read DER signature
with open('temp_signature.der', 'rb') as f:
    der_data = f.read()

print(f'DER signature length: {len(der_data)} bytes')

# Parse DER manually for ECDSA signature
# DER format: 30 [length] 02 [r_length] [r_bytes] 02 [s_length] [s_bytes]
if der_data[0] != 0x30:
    print('Invalid DER signature')
    sys.exit(1)

# Skip sequence header
pos = 2  # Skip 0x30 and length byte

# Parse r
if der_data[pos] != 0x02:
    print('Invalid DER signature: r not found')
    sys.exit(1)
pos += 1
r_length = der_data[pos]
pos += 1
r_bytes = der_data[pos:pos + r_length]
pos += r_length

# Parse s  
if der_data[pos] != 0x02:
    print('Invalid DER signature: s not found')
    sys.exit(1)
pos += 1
s_length = der_data[pos]
pos += 1
s_bytes = der_data[pos:pos + s_length]

print(f'r length: {r_length}, s length: {s_length}')

# Pad or trim to exactly 32 bytes each
def pad_or_trim_to_32(value_bytes):
    if len(value_bytes) == 32:
        return value_bytes
    elif len(value_bytes) == 33 and value_bytes[0] == 0x00:
        return value_bytes[1:]
    elif len(value_bytes) < 32:
        return b'\x00' * (32 - len(value_bytes)) + value_bytes
    else:
        raise ValueError(f'Invalid signature component length: {len(value_bytes)}')

r_32 = pad_or_trim_to_32(r_bytes)
s_32 = pad_or_trim_to_32(s_bytes)

# Combine r and s
raw_signature = r_32 + s_32

print(f'Raw signature length: {len(raw_signature)} bytes')

# Write raw signature
with open('static/firmware/esp32/fwv0.0.13/firmware.sig', 'wb') as f:
    f.write(raw_signature)

print('✅ Signature converted and saved') 