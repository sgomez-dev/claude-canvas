import { inflateSync } from "node:zlib";

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  /**
   * RGBA, four bytes per pixel, row-major, no padding.
   *
   * Normalised to RGBA even when the file was RGB, so every renderer
   * downstream -- half-blocks, Sixel, Kitty -- handles one layout instead
   * of branching on channel count. An RGB source gets alpha 255.
   */
  pixels: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Ceiling on decoded pixels, checked BEFORE allocating.
 *
 * A PNG header is eight bytes that can claim any dimensions, so a malformed
 * or hostile file could otherwise ask for a 40 GB buffer. 16 megapixels
 * covers 4K (8.3 MP) with room to spare, and is the same
 * check-before-allocating discipline `protocol.ts` applies to its frame
 * ceiling.
 */
const MAX_PIXELS = 16 * 1024 * 1024;

/** Bytes per pixel for the colour types this decoder accepts. */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };

function u32(bytes: Uint8Array, at: number): number {
  // Multiplication rather than `<<`, so a value above 2^31 stays positive --
  // the same reason protocol.ts reads its length prefix this way.
  return (
    bytes[at]! * 0x1000000 + bytes[at + 1]! * 0x10000 + bytes[at + 2]! * 0x100 + bytes[at + 3]!
  );
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

/**
 * Decodes a PNG into RGBA pixels.
 *
 * **Supported subset, stated rather than discovered:** 8-bit-per-channel
 * RGB (colour type 2) and RGBA (colour type 6), non-interlaced. Palette,
 * greyscale, 16-bit and interlaced files are rejected with a message naming
 * what they are, because every screenshot tool in the intended path emits
 * 8-bit RGB or RGBA and a silent wrong render is worse than a refusal.
 *
 * No dependency: `node:zlib`'s inflate is built into Bun, so this is chunk
 * parsing plus inflate plus scanline un-filtering.
 *
 * CRCs are deliberately not verified. A corrupted chunk almost always makes
 * inflate fail, which surfaces as an error anyway, and checking them would
 * add a table and a pass over every byte to catch the narrow case where
 * corruption happens to inflate cleanly.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (bytes.byteLength < 8 + 25) {
    throw new PngDecodeError("not a PNG: too short to contain a header");
  }
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new PngDecodeError("not a PNG: signature does not match");
    }
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  let sawHeader = false;
  const idat: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.byteLength) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(
      bytes[at + 4]!,
      bytes[at + 5]!,
      bytes[at + 6]!,
      bytes[at + 7]!
    );
    const dataAt = at + 8;
    if (dataAt + length + 4 > bytes.byteLength) {
      throw new PngDecodeError(`truncated PNG: chunk ${type} claims ${length} bytes past the end`);
    }

    if (type === "IHDR") {
      if (length !== 13) throw new PngDecodeError(`malformed IHDR: ${length} bytes, expected 13`);
      width = u32(bytes, dataAt);
      height = u32(bytes, dataAt + 4);
      const bitDepth = bytes[dataAt + 8]!;
      const colourType = bytes[dataAt + 9]!;
      const interlace = bytes[dataAt + 12]!;

      if (width === 0 || height === 0) {
        throw new PngDecodeError(`PNG has zero extent: ${width}x${height}`);
      }
      // Before allocating anything, so a header claiming absurd dimensions
      // cannot make us reserve the memory it asks for.
      if (width * height > MAX_PIXELS) {
        throw new PngDecodeError(
          `PNG is too large: ${width}x${height} exceeds the ${MAX_PIXELS} pixel ceiling`
        );
      }
      if (bitDepth !== 8) {
        throw new PngDecodeError(
          `unsupported PNG bit depth ${bitDepth}: only 8 bits per channel is supported`
        );
      }
      if (interlace !== 0) {
        throw new PngDecodeError("unsupported PNG: interlaced (Adam7) files are not supported");
      }
      const named: Record<number, string> = {
        0: "greyscale",
        3: "palette",
        4: "greyscale with alpha",
      };
      if (named[colourType] !== undefined) {
        throw new PngDecodeError(
          `unsupported PNG colour type ${colourType} (${named[colourType]}): only RGB and RGBA are supported`
        );
      }
      const c = CHANNELS[colourType];
      if (c === undefined) {
        throw new PngDecodeError(`unrecognised PNG colour type ${colourType}`);
      }
      channels = c;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader) throw new PngDecodeError("malformed PNG: IDAT before IHDR");
      // Held as a list and joined once, rather than re-concatenated per
      // chunk: the same O(n^2) trap FrameDecoder was rewritten to avoid.
      idat.push(bytes.subarray(dataAt, dataAt + length));
    } else if (type === "IEND") {
      break;
    }

    at = dataAt + length + 4;
  }

  if (!sawHeader) throw new PngDecodeError("malformed PNG: no IHDR chunk");
  if (idat.length === 0) throw new PngDecodeError("malformed PNG: no image data");

  const total = idat.reduce((sum, c) => sum + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of idat) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const stride = width * channels;
  // Every scanline carries one leading filter-type byte. Computed BEFORE
  // inflating -- not just before the post-inflate size check below -- and
  // passed as `maxOutputLength`, so a compressed IDAT engineered to inflate
  // to far more than this header could ever need (a "zlib bomb": a tiny
  // compressed payload that decompresses to gigabytes) is rejected by zlib
  // itself as soon as it exceeds this bound, instead of first being fully
  // inflated into an unbounded allocation. The MAX_PIXELS check above already
  // bounds `expected` to a sane ceiling, so this can never itself demand an
  // absurd allocation.
  const expected = (stride + 1) * height;

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(joined, { maxOutputLength: expected }));
  } catch (e) {
    throw new PngDecodeError(`PNG image data could not be decompressed: ${(e as Error).message}`);
  }

  if (raw.byteLength < expected) {
    throw new PngDecodeError(
      `truncated PNG image data: ${raw.byteLength} bytes, expected ${expected}`
    );
  }

  // Un-filtered scanlines, kept in the source's channel count so the filter
  // arithmetic operates on the bytes the encoder actually filtered.
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      // a: the byte one pixel to the left; b: the byte above; c: above-left.
      // Out of bounds counts as zero, which is what the spec prescribes for
      // the first pixel and the first row.
      const a = i >= channels ? lines[dst + i - channels]! : 0;
      const b = y > 0 ? lines[up + i]! : 0;
      const c = y > 0 && i >= channels ? lines[up + i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new PngDecodeError(`unrecognised PNG scanline filter ${filter} on row ${y}`);
      }
      lines[dst + i] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, pixels: lines };

  // RGB to RGBA, so downstream renderers see one layout.
  const pixels = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < lines.byteLength; p += 3, q += 4) {
    pixels[q] = lines[p]!;
    pixels[q + 1] = lines[p + 1]!;
    pixels[q + 2] = lines[p + 2]!;
    pixels[q + 3] = 255;
  }
  return { width, height, pixels };
}
