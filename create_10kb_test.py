#!/usr/bin/env python3

# Create 10KB test firmware
content = 'TEST_FIRMWARE_10KB_v1.0_ESP32\n'

# Calculate how many times to repeat to get close to 10KB
target_size = 10240  # 10KB
base_size = len(content.encode('utf-8'))
repeats = target_size // base_size
remainder = target_size % base_size

# Create the content
full_content = content * repeats
if remainder > 0:
    full_content += content[:remainder]

# Ensure it's exactly 10KB
full_content = full_content[:target_size]

# Write to file
with open('test_10kb_firmware.bin', 'wb') as f:
    f.write(full_content.encode('utf-8'))

print(f'Created test_10kb_firmware.bin: {len(full_content.encode("utf-8"))} bytes')
print(f'Content preview: {repr(full_content[:100])}...')

# Calculate SHA256 hash for verification
import hashlib
hash_obj = hashlib.sha256(full_content.encode('utf-8'))
print(f'SHA256 hash: {hash_obj.hexdigest()}') 