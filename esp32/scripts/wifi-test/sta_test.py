#!/usr/bin/env python3
"""One-shot WiFi/TCP round-trip test for ChromaBay firmware (feat>=2).

Provisions a nearby ChromaBay device onto your Wi-Fi over BLE (STA mode, revert-to-BLE
fallback), waits for it to join, resolves <name>.local (or a given IP), then exercises the
framed TCP control protocol: device-info, LED config, brightness, a pattern push, and a
library dump. Your Mac stays on its normal network the whole time (device is a STA on the LAN).

Setup (once):
    python3 -m venv .venv && ./.venv/bin/pip install bleak msgpack

Usage:
    ./.venv/bin/python sta_test.py "MyWifi" "wifi-password"
    ./.venv/bin/python sta_test.py "MyWifi" "wifi-password" --name ChromaBay_ED30
    ./.venv/bin/python sta_test.py --ip 192.168.1.42          # already provisioned; just test TCP

To put the device back on Bluetooth afterward: hold nothing — either re-run with mode ble via
the app, or erase NVS over USB:
    esptool.py --port <port> erase_region 0x9000 0x5000
"""
import argparse, asyncio, socket, struct, sys, time
import msgpack

COMM_CONFIG = "a0be83fa-8dc9-47f0-ab40-b19721d20ed1"
TCP_PORT = 8080
CH = dict(DEVICE_INFO=1, LED_CONFIG_GET=2, BRIGHTNESS=4, PATTERN_SYNC=5,
          LIBRARY_DUMP=9, COMM_CONFIG=11)


async def provision(ssid, password, name_prefix):
    from bleak import BleakScanner, BleakClient
    print(f"[BLE] scanning for {name_prefix}* …")
    dev = None
    for d in await BleakScanner.discover(timeout=8.0):
        if d.name and d.name.startswith(name_prefix):
            dev = d
            break
    if not dev:
        print("[BLE] no matching device found"); sys.exit(1)
    print(f"[BLE] provisioning {dev.name} → STA '{ssid}'")
    async with BleakClient(dev) as c:
        patch = {"mode": "wifi", "ssid": ssid, "pass": password, "fallback": 0}
        await c.write_gatt_char(COMM_CONFIG, msgpack.packb(patch, use_bin_type=True), response=True)
    # Sanitized mDNS host = lowercase name, non-alnum → hyphen.
    host = "".join(ch.lower() if ch.isalnum() else "-" for ch in dev.name).strip("-")
    return host + ".local"


def send(s, ch, payload=b""):
    s.sendall(bytes([ch]) + struct.pack("<I", len(payload)) + payload)


def recv(s, timeout=4.0):
    s.settimeout(timeout)
    hdr = b""
    while len(hdr) < 5:
        b = s.recv(5 - len(hdr))
        if not b:
            return None
        hdr += b
    n = struct.unpack("<I", hdr[1:5])[0]
    data = b""
    while len(data) < n:
        b = s.recv(n - len(data))
        if not b:
            break
        data += b
    return hdr[0], data


def tcp_test(host):
    print(f"[TCP] connecting {host}:{TCP_PORT} …")
    # Retry mDNS resolution while the device boots + joins.
    s = None
    for attempt in range(20):
        try:
            s = socket.create_connection((host, TCP_PORT), timeout=4)
            break
        except OSError:
            time.sleep(2)
    if not s:
        print("[TCP] could not connect (device not on the LAN yet?)"); sys.exit(1)
    print("[TCP] connected")
    send(s, CH["DEVICE_INFO"]); print("  device-info:", recv(s)[1].decode("utf-8", "replace"))
    send(s, CH["LED_CONFIG_GET"]); print("  led-config:", len(recv(s)[1]), "bytes")
    send(s, CH["BRIGHTNESS"], bytes([90])); time.sleep(0.2)
    send(s, CH["BRIGHTNESS"]); print("  brightness read-back:", recv(s)[1][0], "(set 90)")
    pat = {"meta": {"name": "sta-test", "output": 0}, "nodes": [{"t": "rainbow", "o": 0, "p": {}}]}
    send(s, CH["PATTERN_SYNC"], msgpack.packb(pat, use_bin_type=True)); print("  pushed rainbow")
    send(s, CH["LIBRARY_DUMP"])
    n = 0
    while True:
        r = recv(s, 3.0)
        if not r or len(r[1]) == 0:
            break
        n += 1
    print(f"  library: {n} pattern(s)")
    s.close()
    print("[TCP] ✅ round-trip OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ssid", nargs="?")
    ap.add_argument("password", nargs="?", default="")
    ap.add_argument("--name", default="ChromaBay")
    ap.add_argument("--ip", help="skip BLE provisioning; test this address directly")
    a = ap.parse_args()
    if a.ip:
        tcp_test(a.ip)
    else:
        if not a.ssid:
            ap.error("provide SSID (and password) or --ip")
        host = asyncio.run(provision(a.ssid, a.password, a.name))
        print(f"[..] waiting for {host} to come up")
        time.sleep(8)
        tcp_test(host)


if __name__ == "__main__":
    main()
