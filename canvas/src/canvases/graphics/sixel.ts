import type { DecodedImage } from "../png";
import { resampleRGB, DEFAULT_BACKGROUND, type RGB } from "./resample";

/**
 * Sixel.
 *
 * `<ESC>Pq` … `<ESC>\` — a DCS whose body encodes six vertical pixels per
 * printable character. Unlike kitty and iTerm2, Sixel has **no notion of a
 * cell box**: it places pixels, so the image has to be resampled to an
 * exact pixel grid before encoding, and that means knowing how many pixels
 * a cell is. See CELL_PIXELS.
 *
 * Emitted only to a terminal detected as supporting it. A terminal that does
 * not will print the body as text, which is a screenful of garbage -- far
 * worse than a lower-fidelity image, and the reason `detectGraphics` refuses
 * to infer this tier from `TERM`.
 */

/** Sixel registers: 256 is the common ceiling, and more is rarely honoured. */
export const MAX_COLOURS = 256;

/**
 * Assumed pixel size of one terminal cell.
 *
 * There is no way to know this without asking the terminal, and asking means
 * a DA/CSI query whose reply has to travel back through tmux and may never
 * arrive -- the same reason `detectGraphics` does no interrogation. So it is
 * assumed, and deliberately assumed **small**.
 *
 * The asymmetry is the whole argument: guess too small and the image
 * under-fills its reserved rows, leaving a gap. Guess too large and it
 * overflows them, pushing the footer off screen and corrupting a layout Ink
 * believes it has already drawn. A gap is a blemish; an overflow is a bug.
 * Real cells are usually 8-10 x 16-22 px.
 *
 * Overridable with `CANVAS_CELL_PIXELS=WxH` for anyone who knows their own
 * terminal, the same lever `CANVAS_GRAPHICS` gives for the tier itself.
 */
export const CELL_PIXELS = { width: 8, height: 16 };

export function resolveCellPixels(env: NodeJS.ProcessEnv): { width: number; height: number } {
  const raw = env.CANVAS_CELL_PIXELS;
  if (raw === undefined || raw.length === 0) return CELL_PIXELS;
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (m === null) {
    throw new Error(
      `Invalid CANVAS_CELL_PIXELS: ${JSON.stringify(raw)}. Expected WIDTHxHEIGHT, e.g. "10x20".`
    );
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 1 || height < 1) {
    throw new Error(`Invalid CANVAS_CELL_PIXELS: ${JSON.stringify(raw)}. Both must be at least 1.`);
  }
  return { width, height };
}

interface Box {
  keys: number[];
  counts: number[];
  total: number;
}

function boxRange(box: Box): { channel: 0 | 1 | 2; extent: number } {
  let lo = [255, 255, 255];
  let hi = [0, 0, 0];
  for (const key of box.keys) {
    const c = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    for (let i = 0; i < 3; i++) {
      if (c[i]! < lo[i]!) lo[i] = c[i]!;
      if (c[i]! > hi[i]!) hi[i] = c[i]!;
    }
  }
  let channel: 0 | 1 | 2 = 0;
  let extent = hi[0]! - lo[0]!;
  for (const i of [1, 2] as const) {
    const e = hi[i]! - lo[i]!;
    if (e > extent) {
      extent = e;
      channel = i;
    }
  }
  return { channel, extent };
}

/**
 * Median-cut palette.
 *
 * A fixed uniform colour cube would be far less code, and would band every
 * gradient visibly -- this tier exists to be better than half-blocks, and a
 * screenshot is mostly a handful of near-identical background tones plus
 * text, which an adaptive palette spends its registers on and a uniform one
 * wastes them away from.
 *
 * Splits the box holding the most pixels, along its own longest channel, at
 * the median. Stops early when nothing is left to split, which is what
 * happens for an image with fewer distinct colours than registers.
 */
export function medianCut(rgb: Uint8Array, maxColours = MAX_COLOURS): RGB[] {
  // `nearestIndexes` feeds every resulting palette index into a `Uint8Array`
  // lookup cube (`cube[...] = best`), which can only represent 0-255. Only
  // ever called with 256 in practice, but a future caller passing more would
  // otherwise silently WRAP (256 becomes 0, 257 becomes 1, ...) rather than
  // erroring -- corrupting the palette instead of failing loudly.
  if (maxColours > 256) {
    throw new Error(
      `medianCut: maxColours must be at most 256 (the palette-index lookup is a Uint8Array), got ${maxColours}`
    );
  }
  const histogram = new Map<number, number>();
  for (let i = 0; i < rgb.length; i += 3) {
    const key = (rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const keys = [...histogram.keys()];
  const counts = keys.map((k) => histogram.get(k)!);
  let boxes: Box[] = [{ keys, counts, total: counts.reduce((a, b) => a + b, 0) }];

  while (boxes.length < maxColours) {
    // The box with the most pixels in it, among those that can still split.
    let pick = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      if (b.keys.length < 2) continue;
      if (b.total > best) {
        best = b.total;
        pick = i;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick]!;
    const { channel } = boxRange(box);
    const shift = channel === 0 ? 16 : channel === 1 ? 8 : 0;
    const order = box.keys
      .map((k, i) => ({ k, c: box.counts[i]! }))
      .sort((a, b) => ((a.k >> shift) & 0xff) - ((b.k >> shift) & 0xff));
    // Split at the pixel-weighted median, not the halfway index: a box whose
    // colours are lopsided in population would otherwise split into one
    // crowded half and one nearly empty one, wasting a register.
    let half = box.total / 2;
    let at = 0;
    for (; at < order.length - 1; at++) {
      half -= order[at]!.c;
      if (half <= 0) break;
    }
    // The weighted median puts everything on one side when a single colour
    // holds more than half the box AND sorts last on this channel -- which
    // is the common case, not a corner one: a screenshot is mostly one
    // background tone. Measured on this repository's own screenshot: 7029
    // distinct colours collapsed to a palette of 4, because the empty side
    // used to abandon the whole loop rather than just this split. Falling
    // back to the index median always yields two non-empty sides, since a
    // box only reaches here with at least two colours in it.
    if (at >= order.length - 1) at = Math.floor(order.length / 2) - 1;
    const left = order.slice(0, at + 1);
    const right = order.slice(at + 1);
    const mk = (arr: typeof order): Box => ({
      keys: arr.map((e) => e.k),
      counts: arr.map((e) => e.c),
      total: arr.reduce((a, e) => a + e.c, 0),
    });
    boxes = [...boxes.slice(0, pick), mk(left), mk(right), ...boxes.slice(pick + 1)];
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < box.keys.length; i++) {
      const k = box.keys[i]!;
      const w = box.counts[i]!;
      r += ((k >> 16) & 0xff) * w;
      g += ((k >> 8) & 0xff) * w;
      b += (k & 0xff) * w;
    }
    return {
      r: Math.round(r / box.total),
      g: Math.round(g / box.total),
      b: Math.round(b / box.total),
    };
  });
}

/**
 * Maps every pixel to its nearest palette entry.
 *
 * Through a 5-bit lookup cube rather than a per-pixel search over the
 * palette: a full-pane image is a few hundred thousand pixels and a search
 * would be that times 256 distance computations. The cube is 32768 entries
 * built once, and every pixel is then one index.
 */
function nearestIndexes(rgb: Uint8Array, palette: RGB[]): Uint8Array {
  const cube = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r++) {
    for (let g = 0; g < 32; g++) {
      for (let b = 0; b < 32; b++) {
        // Centre of the 5-bit bucket, so the cube's own quantisation does
        // not bias every lookup toward the low end of each bucket.
        const cr = r * 8 + 4;
        const cg = g * 8 + 4;
        const cb = b * 8 + 4;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < palette.length; i++) {
          const p = palette[i]!;
          const d = (p.r - cr) ** 2 + (p.g - cg) ** 2 + (p.b - cb) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        cube[(r << 10) | (g << 5) | b] = best;
      }
    }
  }
  const out = new Uint8Array(rgb.length / 3);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o++) {
    out[o] = cube[((rgb[i]! >> 3) << 10) | ((rgb[i + 1]! >> 3) << 5) | (rgb[i + 2]! >> 3)]!;
  }
  return out;
}

/** Run-length encodes one colour's row of sixel characters. */
function rle(masks: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < masks.length) {
    const value = masks[i]!;
    let run = 1;
    while (i + run < masks.length && masks[i + run] === value) run++;
    const char = String.fromCharCode(0x3f + value);
    // `!<n><char>` is 3 characters plus the digits, so it only pays from 4
    // repeats up. Below that the literal run is shorter.
    if (run >= 4) out += `!${run}${char}`;
    else out += char.repeat(run);
    i += run;
  }
  return out;
}

export interface SixelPlacement {
  columns: number;
  rows: number;
}

/**
 * Encodes an image as a Sixel DCS, sized for a `columns` x `rows` cell box.
 *
 * Returned as a single-element array to match the other encoders, so tmux
 * passthrough wrapping is applied the same way for every tier.
 */
export function encodeSixel(
  img: DecodedImage,
  placement: SixelPlacement,
  background: RGB = DEFAULT_BACKGROUND,
  cell: { width: number; height: number } = CELL_PIXELS,
  maxColours = MAX_COLOURS
): string[] {
  const width = Math.max(1, placement.columns * cell.width);
  const height = Math.max(1, placement.rows * cell.height);
  const rgb = resampleRGB(img, width, height, background);
  const palette = medianCut(rgb, maxColours);
  const indexes = nearestIndexes(rgb, palette);

  const parts: string[] = [];
  // P1=0 (aspect 1:1), P2=1 (a zero bit leaves the pixel untouched rather
  // than painting it the background colour), P3=0.
  parts.push("\x1bP0;1;0q");
  // Raster attributes. Declaring the size up front lets a terminal allocate
  // once instead of growing the image as bands arrive, and pins the aspect
  // ratio at 1:1 so nothing rescales what was already fitted.
  parts.push(`"1;1;${width};${height}`);
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    // Sixel colour components are PERCENTAGES, 0-100, not 0-255. Sending
    // 0-255 values here is the classic mistake: everything clips to white.
    const pc = (v: number) => Math.round((v * 100) / 255);
    parts.push(`#${i};2;${pc(p.r)};${pc(p.g)};${pc(p.b)}`);
  }

  const bands = Math.ceil(height / 6);
  const masks = new Map<number, Uint8Array>();
  for (let band = 0; band < bands; band++) {
    masks.clear();
    const y0 = band * 6;
    const rowsInBand = Math.min(6, height - y0);
    for (let dy = 0; dy < rowsInBand; dy++) {
      const bit = 1 << dy;
      const rowStart = (y0 + dy) * width;
      for (let x = 0; x < width; x++) {
        const idx = indexes[rowStart + x]!;
        let m = masks.get(idx);
        if (m === undefined) {
          m = new Uint8Array(width);
          masks.set(idx, m);
        }
        m[x] = m[x]! | bit;
      }
    }
    // Only the colours actually present in this band are emitted, and they
    // are emitted in index order so the output is deterministic.
    const present = [...masks.keys()].sort((a, b) => a - b);
    present.forEach((idx, i) => {
      parts.push(`#${idx}${rle(masks.get(idx)!)}`);
      // `$` returns to the start of the same band so the next colour
      // overlays it; `-` would move on and lose it.
      if (i < present.length - 1) parts.push("$");
    });
    if (band < bands - 1) parts.push("-");
  }

  parts.push("\x1b\\");
  return [parts.join("")];
}
