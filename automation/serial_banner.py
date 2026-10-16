#!/usr/bin/env python3
# Usage: serial_banner.py <port> [seconds] — resets the board (RTS) and prints its boot banner.
# The 'Device name: X' line is the only trustworthy answer to 'which device is on the cable'.
import serial, time, sys
s = serial.Serial(sys.argv[1], 115200, timeout=0.2)
# reset into app: EN low via RTS, IO0 high via DTR
s.dtr = False; s.rts = True; time.sleep(0.15); s.rts = False
end = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 8)
while time.time() < end:
    l = s.readline()
    if l: sys.stdout.write(l.decode(errors='replace')); sys.stdout.flush()
