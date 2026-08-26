#!/usr/bin/env python3
# Firmware OTA over Bluetooth, for a device that cannot be reached any other way.
#
# The Wi-Fi carriage (automation/wifi-ota.mjs) is the fast path and should be preferred.
# This exists because a device in BLE mode has no Wi-Fi at all — and because dropping the
# Wi-Fi stack frees the tens of KB of contiguous heap that a firmware update needs on a
# memory-tight classic ESP32.
#
# Safety is deliberately strict, and not negotiable: real ChromaBay installations (Portal,
# Butterfly) are powered and advertising within BLE range of this machine at all times. The
# target is matched by EXACT name, every other ChromaBay seen is logged and ignored, and the
# name is re-read from DEVICE_INFO over the connection before a single byte of firmware is
# sent. Never relax this into a pattern match.
#
# Usage:
#   python3 automation/ble_ota.py --name ChromaBay_X --firmware fw.bin --signature fw.sig
#   python3 automation/ble_ota.py --name ChromaBay_X --info-only
#   python3 automation/ble_ota.py --name ChromaBay_X --set-mode wifi
#
# --set-mode is the way back. A device switched to BLE has no Wi-Fi to be told anything over,
# so the return trip has to ride the same radio that got us here.
import argparse, asyncio, json, sys, time
from bleak import BleakClient, BleakScanner

SVC        = 'a0be83e4-8dc9-47f0-ab40-b19721d20ed1'
DEVICE_INFO= 'a0be83e7-8dc9-47f0-ab40-b19721d20ed1'
OTA_CONTROL= 'a0be83e8-8dc9-47f0-ab40-b19721d20ed1'
OTA_DATA   = 'a0be83e9-8dc9-47f0-ab40-b19721d20ed1'
OTA_STATUS = 'a0be83ea-8dc9-47f0-ab40-b19721d20ed1'
OTA_SIG    = 'a0be83eb-8dc9-47f0-ab40-b19721d20ed1'
COMM_CONFIG= 'a0be83fa-8dc9-47f0-ab40-b19721d20ed1'


def mode_patch(mode):
    """msgpack fixmap(1) {"mode": mode} — the same patch the app writes."""
    v = b'\xa4wifi' if mode == 'wifi' else b'\xa3ble'
    return b'\x81\xa4mode' + v

CHUNK = 500        # MAX_BLE_CHUNK_SIZE in the firmware
WINDOW = 8         # chunks in flight; BLE writes are tiny, so heap is not the constraint here


async def find(name, timeout):
    print(f'scanning for exactly "{name}" ...')
    devs = await BleakScanner.discover(timeout=timeout)
    target, others = None, []
    for d in devs:
        if not d.name:
            continue
        if d.name.strip() == name:
            target = d
        elif 'hroma' in d.name:
            others.append(d.name)
    for o in sorted(set(others)):
        print(f'  ignoring other ChromaBay in range: {o}')
    if not target:
        raise SystemExit(f'no device named exactly "{name}" is advertising')
    print(f'found {target.name} [{target.address}]')
    return target


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True, help='exact device name from DEVICE_INFO')
    ap.add_argument('--firmware')
    ap.add_argument('--signature')
    ap.add_argument('--unsigned', action='store_true')
    ap.add_argument('--info-only', action='store_true')
    ap.add_argument('--set-mode', choices=['wifi', 'ble'],
                    help='flip the transport and reboot into it (nothing else is changed)')
    ap.add_argument('--scan-timeout', type=float, default=12.0)
    a = ap.parse_args()
    if not a.info_only and not a.set_mode and not a.firmware:
        raise SystemExit('--firmware is required unless --info-only / --set-mode')
    if a.firmware and (bool(a.signature) == bool(a.unsigned)):
        raise SystemExit('pass exactly one of --signature=<file> or --unsigned')

    dev = await find(a.name, a.scan_timeout)

    acked = 0
    fault = None
    last_status = ''

    def on_ack(_h, _d):
        nonlocal acked
        acked += 1

    def on_status(_h, data):
        nonlocal fault, last_status
        last_status = data.decode('utf-8', 'replace')
        print(f'[status] {last_status}')
        # A refusal and a silent device look identical to a sender watching only ACKs.
        if last_status.startswith('OTA_ERR'):
            fault = last_status

    async with BleakClient(dev, timeout=30.0) as client:
        raw = await client.read_gatt_char(DEVICE_INFO)
        info = json.loads(raw.decode())
        if info.get('name') != a.name:
            raise SystemExit(f'REFUSING: connected device reports "{info.get("name")}", expected "{a.name}"')
        print(f'verified {info["name"]} ({info.get("chip")}, {info.get("fw_ver")}) '
              f'heap={info.get("heap")} mode={info.get("mode")}')
        if a.info_only:
            return

        if a.set_mode:
            print(f'switching transport to {a.set_mode}; the device reboots into it')
            await client.write_gatt_char(COMM_CONFIG, mode_patch(a.set_mode), response=True)
            await asyncio.sleep(1.5)
            return

        fw = open(a.firmware, 'rb').read()
        sig = open(a.signature, 'rb').read() if a.signature else None
        if sig is not None and len(sig) != 64:
            raise SystemExit(f'signature is {len(sig)} bytes, expected 64')
        print(f'firmware {len(fw)} bytes, {(len(fw)+CHUNK-1)//CHUNK} chunks of {CHUNK}')

        await client.start_notify(OTA_STATUS, on_status)
        await client.start_notify(OTA_DATA, on_ack)

        sent = 0
        off = 0
        t0 = time.time()
        while off < len(fw):
            while sent - acked >= WINDOW:
                if fault:
                    raise SystemExit(f'device stopped the update: {fault}')
                await asyncio.sleep(0.005)
                if time.time() - t0 > 900:
                    raise SystemExit('overall timeout')
            if fault:
                raise SystemExit(f'device stopped the update: {fault}')
            end = min(off + CHUNK, len(fw))
            await client.write_gatt_char(OTA_DATA, fw[off:end], response=False)
            off = end
            sent += 1
            if sent % 200 == 0 or off == len(fw):
                print(f'  {off*100//len(fw)}% ({sent} sent, {acked} acked, {time.time()-t0:.0f}s)')

        deadline = time.time() + 30
        while acked < sent and time.time() < deadline and not fault:
            await asyncio.sleep(0.02)
        print(f'transfer complete: {len(fw)} bytes in {time.time()-t0:.0f}s ({acked}/{sent} acked)')
        if fault:
            raise SystemExit(f'device stopped the update: {fault}')

        if sig:
            await client.write_gatt_char(OTA_SIG, sig, response=True)
        cmd = b'END_OTA' if sig else b'END_OTA_UNSIGNED'
        await client.write_gatt_char(OTA_CONTROL, cmd, response=True)

        # Verification runs on the device; a reboot is the success signal.
        end = time.time() + 90
        while time.time() < end:
            if last_status == 'OTA_SUCCESS_REBOOTING':
                print('device reported success and reboot')
                return
            if fault:
                raise SystemExit(f'device stopped the update: {fault}')
            await asyncio.sleep(0.2)
        print(f'no success status within 90s; last status: {last_status or "none"}')

asyncio.run(main())
