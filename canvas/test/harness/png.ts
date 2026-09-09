import { deflateSync } from "node:zlib";

// --- a test-only PNG encoder ---------------------------------------------
//
// Real PNGs are the better fixture and one is used below, but a real encoder
// picks its own filters -- the screenshot in this repository uses filter 2
// and nothing else -- so the other four filter types need files built by
// hand. CRCs are computed properly, so these are valid PNGs rather than
// something only this decoder would accept.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)), false);
  return out;
}

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function ihdr(width: number, height: number, colourType: number, bitDepth = 8, interlace = 0) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width, false);
  v.setUint32(4, height, false);
  d[8] = bitDepth;
  d[9] = colourType;
  d[12] = interlace;
  return chunk("IHDR", d);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Filters `pixels` with the given type and wraps the result in a PNG. */
export function encode(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Uint8Array,
  filter: number
): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const here = pixels[y * stride + i]!;
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      let enc: number;
      switch (filter) {
        case 0: enc = here; break;
        case 1: enc = here - a; break;
        case 2: enc = here - b; break;
        case 3: enc = here - ((a + b) >> 1); break;
        case 4: enc = here - paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      raw[y * (stride + 1) + 1 + i] = enc & 0xff;
    }
  }
  return join([
    SIGNATURE,
    ihdr(width, height, channels === 4 ? 6 : 2),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Deterministic but non-uniform pixels: uniform ones hide filter bugs. */
export function pattern(width: number, height: number, channels: 3 | 4): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      out[o] = (x * 37 + y * 11) & 0xff;
      out[o + 1] = (x * 5 + y * 91) & 0xff;
      out[o + 2] = (x * 199 + y * 3) & 0xff;
      if (channels === 4) out[o + 3] = (x + y) % 2 === 0 ? 255 : 128;
    }
  }
  return out;
}
