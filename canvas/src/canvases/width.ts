// Display width in terminal columns.
//
// `String.length` counts UTF-16 code units, which is the wrong unit three
// times over: a CJK ideograph occupies two columns but one code unit, an
// astral emoji occupies two columns but two code units, and a ZWJ sequence
// like a family emoji occupies two columns but *eleven*. Measuring a table
// column with `.length` therefore misaligned every row containing any of
// them -- the limitation table.tsx shipped with and documented.
//
// No new dependency: `Intl.Segmenter` is built into Bun and gives correct
// grapheme clustering, which is the hard half. The width of a cluster is
// then decided by its leading code point, with one override for emoji
// presentation.
//
// The range table below is a deliberate practical subset of UAX #11, not a
// generated implementation of it. It covers the ranges a terminal actually
// renders double-width -- CJK, Hangul, Kana, fullwidth forms, the main
// emoji blocks -- and treats combining marks and the zero-width controls as
// zero. East Asian *Ambiguous* characters are treated as width 1, which is
// what a terminal in a Latin locale does. Anything outside the table is 1.
//
// One limit is the domain's, not this code's: a ZWJ sequence such as a
// family emoji is one grapheme of two columns by the emoji convention, and
// that is what this returns -- but a terminal without ZWJ support draws the
// component emoji side by side and occupies more. No measurement can
// reconcile those two, so alignment of ZWJ sequences is only as good as the
// terminal. Single-codepoint emoji, CJK and fullwidth forms, which is what
// real table data contains, are unaffected.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Zero-width: combining marks, joiners, variation selectors.
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xe0100, 0xe01ef], // variation selectors supplement
];

// Double-width.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Kana, Bopomofo, Hangul compat, Kanbun, enclosed CJK
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // playing card black joker
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff], // regional indicators (flags)
  [0x1f300, 0x1f5ff], // misc symbols and pictographs
  [0x1f600, 0x1f64f], // emoticons
  [0x1f680, 0x1f6ff], // transport and map
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK extensions B onward
  [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  // Linear over ~24 entries. Called once per grapheme cluster, which is
  // cheap next to the segmentation itself.
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false; // ranges are sorted, so no later one can match
    if (cp <= hi) return true;
  }
  return false;
}

function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // C0/C1 controls occupy no columns; a table cell should never contain one,
  // but counting them as 1 would silently shift a row.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** Width of one grapheme cluster in terminal columns. */
function clusterWidth(cluster: string): number {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  // U+FE0F asks for emoji presentation, which renders double-width even
  // when the base character alone would not (e.g. "⚠️" versus "⚠").
  if (cluster.includes("️")) return 2;
  return codePointWidth(first);
}

/** Total display width of a string, in terminal columns. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(text)) total += clusterWidth(segment);
  return total;
}

/**
 * Truncates to at most `columns` display columns, never splitting a
 * grapheme cluster and never leaving half of a double-width character.
 */
export function truncateToWidth(text: string, columns: number): string {
  if (columns <= 0) return "";
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = clusterWidth(segment);
    if (used + w > columns) break;
    out += segment;
    used += w;
  }
  return out;
}

/** Right-pads with spaces to exactly `columns` display columns. */
export function padToWidth(text: string, columns: number): string {
  const w = displayWidth(text);
  return w >= columns ? text : text + " ".repeat(columns - w);
}
