#!/usr/bin/env python3
# Usage: serial_log_ts.py <port> <outfile> — appends each serial line prefixed with HOST unix time,
# so it can be lined up with cft-page-log.mjs. Opening the port does not reset an S3.
import serial, sys, time
s = serial.Serial(sys.argv[1], 115200, timeout=0.2)
out = open(sys.argv[2], 'a', buffering=1)
while True:
    try:
        l = s.readline()
    except Exception as e:
        out.write(f"{time.time():.3f} SERIAL-ERR {e}\n"); time.sleep(1); continue
    if l: out.write(f"{time.time():.3f} {l.decode(errors='replace').rstrip()}\n")
