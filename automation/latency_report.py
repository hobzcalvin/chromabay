#!/usr/bin/env python3
# Usage: latency_report.py <dir with page.log + serial.log> <since unix-seconds>
# Merges cft-page-log.mjs + serial_log_ts.py output by host time; reports slider drag -> firmware
# '[T] bri apply' latency and the slow steps (needs firmware built with -DCB_TIMING_TRACE).
# Merge page.log + serial.log after a host time; report drag→apply latency per value.
import sys
S=sys.argv[1]; since=float(sys.argv[2])
ev=[]
for f in ('page.log','serial.log'):
    for l in open(f"{S}/{f}"):
        try: t=float(l.split(' ',1)[0])
        except: continue
        if t>=since: ev.append((t,f[0],l.split(' ',1)[1].rstrip()))
ev.sort()
drag={}; app={}
for t,src,txt in ev:
    if '[drag]' in txt: drag.setdefault(int(txt.split()[-1]),t)
    if '[T] bri apply' in txt: app.setdefault(int(txt.split()[3]),t)
first_drag=min(drag.values()) if drag else None
print('drags',len(drag),'applies',len(app))
if drag and app:
    fa=min(app.values()); print(f"first drag→first apply: {fa-first_drag:.2f}s; last apply {max(app.values())-first_drag:.2f}s after first drag")
for t,src,txt in ev:
    if any(k in txt for k in ('[T] slow','[nav]','LibDump','deviceLibrary','Brightness send failed','timed out','error','Error','pattern rx','Pattern sent','Sending pattern','LED Config')):
        print(f"{t-since:7.2f} {src} {txt[:160]}")
