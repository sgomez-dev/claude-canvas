import { test, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, PngDecodeError } from "./png";

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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)), false);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, colourType: number, bitDepth = 8, interlace = 0) {
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
function encode(
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
function pattern(width: number, height: number, channels: 3 | 4): Uint8Array {
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

// --- round trips ---------------------------------------------------------

// Each filter type separately: the repository's real screenshot uses only
// filter 2, so nothing else would exercise Sub, Average or Paeth. Average
// and Paeth are where the arithmetic is easy to get subtly wrong -- both
// read the pixel above-left, and both have to treat out-of-bounds as zero.
for (const filter of [0, 1, 2, 3, 4]) {
  test(`round-trips RGBA through scanline filter ${filter}`, () => {
    const pixels = pattern(9, 7, 4);
    const decoded = decodePng(encode(9, 7, 4, pixels, filter));
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(7);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });
}

test("an RGB file is normalised to RGBA with opaque alpha", () => {
  const rgb = pattern(5, 4, 3);
  const decoded = decodePng(encode(5, 4, 3, rgb, 4));
  expect(decoded.pixels.byteLength).toBe(5 * 4 * 4);
  for (let p = 0, q = 0; p < rgb.byteLength; p += 3, q += 4) {
    expect(decoded.pixels[q]).toBe(rgb[p]);
    expect(decoded.pixels[q + 1]).toBe(rgb[p + 1]);
    expect(decoded.pixels[q + 2]).toBe(rgb[p + 2]);
    expect(decoded.pixels[q + 3]).toBe(255);
  }
});

test("a single-pixel image decodes, where every neighbour is out of bounds", () => {
  const one = new Uint8Array([10, 20, 30, 40]);
  for (const filter of [0, 1, 2, 3, 4]) {
    expect([...decodePng(encode(1, 1, 4, one, filter)).pixels]).toEqual([...one]);
  }
});

// --- a real file from a real encoder -------------------------------------

// The screenshot committed in this repository: 3384x2160, 8-bit RGBA,
// non-interlaced, and split across hundreds of 4096-byte IDAT chunks, which
// is what exercises the chunk joining. The expected values below were
// produced by an INDEPENDENT decoder (a Python implementation over zlib),
// not by this one -- a round trip against my own encoder cannot catch a
// decoder that is consistently wrong.
test("decodes a real multi-IDAT screenshot, matching an independent decoder", async () => {
  const bytes = new Uint8Array(await Bun.file("media/screenshot.png").arrayBuffer());
  const img = decodePng(bytes);

  expect(img.width).toBe(3384);
  expect(img.height).toBe(2160);
  expect(img.pixels.byteLength).toBe(3384 * 2160 * 4);

  const at = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]];
  };
  expect(at(0, 0)).toEqual([2, 30, 52, 255]);
  expect(at(1, 0)).toEqual([1, 29, 52, 255]);
  expect(at(0, 1)).toEqual([2, 30, 52, 255]);
  expect(at(1692, 1080)).toEqual([39, 43, 52, 255]);
  expect(at(3383, 2159)).toEqual([135, 30, 10, 255]);

  // Every byte, not just five pixels: a filter bug that only shows up in
  // one region would slip past sampled assertions.
  let sum = 0;
  for (const b of img.pixels) sum += b;
  expect(sum).toBe(2930253536);
});

// --- refusals ------------------------------------------------------------

test("rejects anything that is not a PNG", () => {
  expect(() => decodePng(new Uint8Array(0))).toThrow(PngDecodeError);
  expect(() => decodePng(new Uint8Array(64))).toThrow(/signature does not match/);
  expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
});

// The supported subset is stated rather than discovered, and each refusal
// names what the file actually is: a silent wrong render is worse than a
// refusal, and "unsupported" with no detail sends the caller guessing.
test("refuses colour types outside RGB and RGBA, naming them", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 3), ...body]))).toThrow(/palette/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 0), ...body]))).toThrow(/greyscale/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 4), ...body]))).toThrow(
    /greyscale with alpha/
  );
});

test("refuses 16-bit and interlaced files", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6, 16), ...body]))).toThrow(/bit depth 16/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6, 8, 1), ...body]))).toThrow(/interlaced/);
});

// Checked BEFORE allocating: a header is eight bytes that can claim any
// dimensions, so a malformed file could otherwise ask for tens of gigabytes.
test("refuses dimensions past the pixel ceiling without allocating them", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(65535, 65535, 6), ...body]))).toThrow(
    /too large: 65535x65535/
  );
  expect(() => decodePng(join([SIGNATURE, ihdr(0, 4, 6), ...body]))).toThrow(/zero extent/);
});

test("refuses a structurally broken file rather than rendering garbage", () => {
  const idat = chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8))));
  // No IHDR at all.
  expect(() => decodePng(join([SIGNATURE, idat, chunk("IEND", new Uint8Array(0))]))).toThrow(
    /IDAT before IHDR/
  );
  // Header but no image data.
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6), chunk("IEND", new Uint8Array(0))]))).toThrow(
    /no image data/
  );
  // A chunk claiming more bytes than the file holds.
  const truncated = join([SIGNATURE, ihdr(2, 2, 6), idat]);
  const lied = truncated.slice(0, truncated.byteLength - 6);
  expect(() => decodePng(lied)).toThrow(/truncated PNG/);
});

test("refuses image data that is not a valid zlib stream", () => {
  const garbage = chunk("IDAT", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(() =>
    decodePng(join([SIGNATURE, ihdr(2, 2, 6), garbage, chunk("IEND", new Uint8Array(0))]))
  ).toThrow(/could not be decompressed/);
});

test("refuses an unrecognised scanline filter", () => {
  const stride = 2 * 4;
  const raw = new Uint8Array((stride + 1) * 2);
  raw[0] = 9; // no such filter
  const bad = join([
    SIGNATURE,
    ihdr(2, 2, 6),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
  expect(() => decodePng(bad)).toThrow(/unrecognised PNG scanline filter 9 on row 0/);
});

test("refuses image data shorter than the header's dimensions require", () => {
  const short = new Uint8Array(4); // nowhere near (2*4+1)*2
  const bad = join([
    SIGNATURE,
    ihdr(2, 2, 6),
    chunk("IDAT", new Uint8Array(deflateSync(short))),
    chunk("IEND", new Uint8Array(0)),
  ]);
  expect(() => decodePng(bad)).toThrow(/truncated PNG image data/);
});
