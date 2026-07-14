// Share a pattern as a self-contained link — the whole pattern is msgpack-encoded and base64url'd
// into the URL fragment, so no backend/publish is needed and it works for anyone (even logged out).
// The link always points at production so a recipient opens the real app.
import { encode, decode } from '@msgpack/msgpack';
import type { SerializedPattern } from './patternSerializer';

const SHARE_ORIGIN = 'https://chromabay.app';

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Keep only what defines the pattern (nodes carry their params, interactive flags `x`, and
// automation `m`); drop local/cloud identity so the link is portable and stable.
function cleanForShare(p: SerializedPattern): SerializedPattern {
  return { nodes: p.nodes ?? [], meta: { name: p.meta?.name || 'Shared Pattern', output: p.meta?.output ?? 1 } };
}

export function encodePatternToBlob(p: SerializedPattern): string {
  return toB64url(encode(cleanForShare(p)) as Uint8Array);
}
export function decodeBlobToPattern(blob: string): SerializedPattern {
  return decode(fromB64url(blob)) as SerializedPattern;
}
export function buildPatternLink(p: SerializedPattern): string {
  return `${SHARE_ORIGIN}/editor#p=${encodePatternToBlob(p)}`;
}
// Extract the pattern blob from a URL fragment like "#p=xxxx" (or "#foo&p=xxxx"), else null.
export function patternBlobFromHash(hash: string): string | null {
  const m = (hash || '').match(/[#&]p=([^&]+)/);
  return m ? m[1] : null;
}
