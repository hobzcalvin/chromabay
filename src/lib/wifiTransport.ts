// WiFi control transport: talk to a ChromaBay device over WebSocket (ws://<host>:8080/),
// mirroring the firmware's channel protocol. Each WS binary message is [u8 channel][payload]
// — the exact same channels + payloads the BLE path uses, so the device behaves identically
// whether reached over BLE or WiFi.
//
// Browser reality: raw TCP is impossible in a browser, but WebSocket is native. On the iOS
// app (WKWebView) ws:// to a LAN device works with an ATS exception; in local dev (http) it
// works too. The deployed https site can't (mixed content) — WiFi control is native + dev.
import * as msgpack from '@msgpack/msgpack';
import type { DeviceInfo, DeviceSettings, DeviceSettingsPatch, LedConfiguration } from './ble';
import type { SerializedPattern } from './patternSerializer';

export const WIFI_PORT = 8080;

// Channels — must match TcpChannel in esp32/src/main.cpp.
export const CH = {
  DEVICE_INFO: 1, LED_CONFIG_GET: 2, LED_CONFIG_SET: 3, BRIGHTNESS: 4,
  PATTERN_SYNC: 5, PLAYLIST_SYNC: 6, TIMESTAMP_SYNC: 7, LIBRARY_CMD: 8,
  LIBRARY_DUMP: 9, DEVICE_NAME: 10, COMM_CONFIG: 11,
} as const;

const td = new TextDecoder();
const te = new TextEncoder();

export class WifiDevice {
  host: string;                 // "chromabay-ed30.local" or an IP
  private ws: WebSocket | null = null;
  connected = false;
  private pending = new Map<number, (data: Uint8Array) => void>();
  private dump: { entries: SerializedPattern[]; resolve?: (v: SerializedPattern[]) => void } | null = null;
  onClose?: () => void;

  constructor(host: string) { this.host = host; }

  connect(timeoutMs = 6000): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const url = `ws://${this.host}:${WIFI_PORT}/`;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch {} reject(new Error('WiFi connect timed out')); } }, timeoutMs);
      ws.onopen = () => { if (done) return; done = true; clearTimeout(t); this.connected = true; resolve(); };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(t); reject(new Error(`Could not reach ${url}`)); } };
      ws.onclose = () => { this.connected = false; this.ws = null; this.pending.clear(); this.onClose?.(); };
      ws.onmessage = (e) => this.onMessage(new Uint8Array(e.data as ArrayBuffer));
    });
  }

  disconnect() { try { this.ws?.close(); } catch {} this.ws = null; this.connected = false; }

  private onMessage(buf: Uint8Array) {
    if (buf.length < 1) return;
    const ch = buf[0];
    const payload = buf.subarray(1);
    if (ch === CH.LIBRARY_DUMP && this.dump) {
      if (payload.length === 0) { const r = this.dump.resolve; const out = this.dump.entries; this.dump = null; r?.(out); return; } // done
      const z = payload.indexOf(0);
      const mp = z >= 0 ? payload.subarray(z + 1) : payload;
      try { this.dump.entries.push(msgpack.decode(mp) as SerializedPattern); } catch { /* skip bad entry */ }
      return;
    }
    const p = this.pending.get(ch);
    if (p) { this.pending.delete(ch); p(payload); }
  }

  private send(ch: number, payload: Uint8Array = new Uint8Array(0)) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WiFi device not connected');
    const m = new Uint8Array(1 + payload.length);
    m[0] = ch; m.set(payload, 1);
    this.ws.send(m);
  }

  private request(ch: number, payload?: Uint8Array, timeoutMs = 4000): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(ch); reject(new Error(`WiFi request ${ch} timed out`)); }, timeoutMs);
      this.pending.set(ch, (d) => { clearTimeout(t); resolve(d); });
      try { this.send(ch, payload); } catch (e) { clearTimeout(t); this.pending.delete(ch); reject(e as Error); }
    });
  }

  // ---- High-level ops (same wire format as the BLE path) ----
  async getDeviceInfo(): Promise<DeviceInfo> {
    return JSON.parse(td.decode(await this.request(CH.DEVICE_INFO)));
  }
  async getLedConfig(): Promise<LedConfiguration> {
    const raw: any = msgpack.decode(await this.request(CH.LED_CONFIG_GET));
    const strips = (raw.strips ?? []).map((s: any) => ({
      chipset: s.cs, pin: s.pin, clockPin: s.clk ?? 0, numLeds: s.num, colorOrder: s.co,
      rmtChannel: s.rmt ?? 0, width: s.w ?? 0, height: s.h ?? 0, orientation: s.ort ?? 0,
    }));
    return { globalBrightness: raw.gb ?? 255, strips } as unknown as LedConfiguration;
  }
  setBrightness(v: number) { this.send(CH.BRIGHTNESS, Uint8Array.of(Math.max(0, Math.min(255, Math.round(v))))); }
  async readBrightness(): Promise<number> { const d = await this.request(CH.BRIGHTNESS); return d[0]; }

  sendPattern(pattern: SerializedPattern) {
    const clean = { ...pattern, meta: { name: pattern?.meta?.name, output: pattern?.meta?.output ?? 1 }, lib: true };
    this.send(CH.PATTERN_SYNC, msgpack.encode(clean) as Uint8Array);
  }
  setCycle(intervalMs: number, enabled: boolean) {
    const b = new Uint8Array(5); const dv = new DataView(b.buffer);
    dv.setUint32(0, intervalMs, true); b[4] = enabled ? 1 : 0;
    this.send(CH.PLAYLIST_SYNC, b);
  }
  syncTime(epochMs = Date.now()) {
    // [u64 frame-clock ms (performance.now)][u64 wall-epoch ms (Date.now)] — see ble.ts.
    const frameMs = Math.floor(performance.now());
    const b = new Uint8Array(16); const dv = new DataView(b.buffer);
    dv.setUint32(0, frameMs >>> 0, true);  dv.setUint32(4, Math.floor(frameMs / 4294967296), true);
    dv.setUint32(8, epochMs >>> 0, true);  dv.setUint32(12, Math.floor(epochMs / 4294967296), true);
    this.send(CH.TIMESTAMP_SYNC, b);
  }
  async getName(): Promise<string> { return td.decode(await this.request(CH.DEVICE_NAME)); }
  setName(name: string) { this.send(CH.DEVICE_NAME, te.encode(name)); }
  async readSettings(): Promise<DeviceSettings> { return JSON.parse(td.decode(await this.request(CH.COMM_CONFIG))); }
  writeSettings(patch: DeviceSettingsPatch) { this.send(CH.COMM_CONFIG, msgpack.encode(patch) as Uint8Array); }
  clearLibrary() { this.send(CH.LIBRARY_CMD, Uint8Array.of(0x00)); }
  deletePattern(name: string) { const nb = te.encode(name); const m = new Uint8Array(1 + nb.length); m[0] = 0x01; m.set(nb, 1); this.send(CH.LIBRARY_CMD, m); }

  dumpLibrary(timeoutMs = 8000): Promise<SerializedPattern[]> {
    return new Promise((resolve, reject) => {
      this.dump = { entries: [], resolve };
      const t = setTimeout(() => { const out = this.dump?.entries ?? []; this.dump = null; resolve(out); }, timeoutMs);
      const orig = resolve; this.dump.resolve = (v) => { clearTimeout(t); orig(v); };
      try { this.send(CH.LIBRARY_DUMP); } catch (e) { clearTimeout(t); this.dump = null; reject(e as Error); }
    });
  }
}
