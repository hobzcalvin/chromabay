#!/usr/bin/env python3
# Line-oriented serial reader for the driving harness (automation/drive.mjs).
#
# Why pyserial and not `pio device monitor` / `cat` / Node fs:
#   - pio's miniterm needs an interactive TTY and crashes when launched headlessly.
#   - `cat` block-buffers its piped stdout, so lines don't reach the parent promptly.
#   - Node's fs.createReadStream doesn't reliably emit data from a macOS char device.
# pyserial (bundled with PlatformIO) reads the port directly and we flush every line,
# so the harness sees ESP32 output immediately whether or not there's a terminal.
#
# Usage: python -u serial_reader.py <port> [baud]
import sys
import serial

port = sys.argv[1]
baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
s = serial.Serial(port, baud, timeout=0.2)
try:
    while True:
        line = s.readline()
        if line:
            sys.stdout.buffer.write(line)
            sys.stdout.flush()
except (KeyboardInterrupt, serial.SerialException, OSError):
    pass  # killed on harness shutdown / port closed — exit quietly
