/**
 * Audio for the in-app preview. Best effort: the real audio reactivity happens on the device,
 * from its own microphone; this only makes audio patterns look alive while you edit them.
 *
 *   'simulated' (default)  the WASM engine's deterministic 120 bpm groove
 *                          (Audio::simulate in native/AudioReactive.h). No permission prompt,
 *                          and the same everywhere, so thumbnails and tests are stable.
 *   'mic'                  this phone/computer's microphone, analysed by the SAME C++ analyzer
 *                          the firmware runs (pushAudioSamples), so gain/AGC/beat behave alike.
 *
 * Mic capture turns OFF the browser's voice processing (echo cancellation, noise suppression,
 * auto gain): with them on, music is treated as noise and the levels pump.
 */
import { writable, get } from 'svelte/store';

export type PreviewAudioSource = 'simulated' | 'mic';

export const previewAudioSource = writable<PreviewAudioSource>('simulated');
export const previewAudioError = writable<string | null>(null);

// Matches Audio::Source in native/AudioReactive.h.
const SOURCE_LIVE = 1, SOURCE_SIMULATED = 2;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;
let srcNode: MediaStreamAudioSourceNode | null = null;
let heapPtr = 0, heapLen = 0;

function wasm(): any {
  return typeof window !== 'undefined' ? (window as any).getWasmModule?.() : null;
}

function setEngineSource(src: number) {
  const m = wasm();
  m?._setAudioSource?.(src);
}

// The worklet: downmix to mono, average pairs of samples (48/44.1 kHz → ~24/22 kHz, which is
// what the device analyses at), and post blocks of 256 to the main thread.
const WORKLET = `
class CbayCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(256); this.n = 0; this.half = 0; this.acc = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const a = ch[0], b = ch[1];
    for (let i = 0; i < a.length; i++) {
      const s = b ? (a[i] + b[i]) * 0.5 : a[i];
      this.acc += s;
      if (++this.half === 2) {
        this.buf[this.n++] = this.acc * 0.5; this.acc = 0; this.half = 0;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cbay-capture', CbayCapture);
`;

function pushToEngine(block: Float32Array, sampleRate: number) {
  const m = wasm();
  if (!m?._pushAudioSamples || !m._malloc || !m.HEAPF32) return;
  if (heapLen < block.length) {
    if (heapPtr) m._free(heapPtr);
    heapPtr = m._malloc(block.length * 4);
    heapLen = block.length;
  }
  m.HEAPF32.set(block, heapPtr >> 2);
  m._pushAudioSamples(heapPtr, block.length, sampleRate);
}

export async function startPreviewMic(): Promise<boolean> {
  previewAudioError.set(null);
  if (get(previewAudioSource) === 'mic') return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    previewAudioError.set('This browser has no microphone access.');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    ctx = new AudioContext();
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    srcNode = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'cbay-capture');
    const rate = ctx.sampleRate / 2;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => pushToEngine(e.data, rate);
    srcNode.connect(node);
    // Not connected to the destination: nothing is played back.
    setEngineSource(SOURCE_LIVE);
    previewAudioSource.set('mic');
    return true;
  } catch (e: any) {
    stopPreviewMic();
    previewAudioError.set(e?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Microphone unavailable: ${e?.message ?? e}`);
    return false;
  }
}

export function stopPreviewMic() {
  try { node?.port.close(); node?.disconnect(); } catch { /* already gone */ }
  try { srcNode?.disconnect(); } catch { /* already gone */ }
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  node = null; srcNode = null; stream = null; ctx = null;
  setEngineSource(SOURCE_SIMULATED);
  previewAudioSource.set('simulated');
}

export async function togglePreviewMic(): Promise<void> {
  if (get(previewAudioSource) === 'mic') stopPreviewMic();
  else await startPreviewMic();
}

/** Does a pattern use audio at all (an Audio node or an audio-driven automation)? */
export function usesAudio(nodeTypes: string[], modShapes: number[]): boolean {
  return nodeTypes.includes('audio') || modShapes.some((s) => s >= 6);
}
