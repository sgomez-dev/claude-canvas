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
  [0x231a, 0x231b], // watch, hourglass (⌚⌛) -- default-emoji-presentation
  // Individual code points and small runs within Miscellaneous Symbols
  // (U+2600-U+26FF), Dingbats (U+2700-U+27BF) and Miscellaneous Symbols and
  // Arrows (U+2B00-U+2BFF) that render double-width in real terminals --
  // the ones with default EMOJI presentation, as opposed to the block's
  // many default-TEXT-presentation symbols (e.g. ⚠ U+26A0, which stays
  // single-width unless followed by U+FE0F -- see the emoji-presentation-
  // selector test below, and clusterWidth's own FE0F handling above). Not
  // a blanket range over the whole block on purpose: an earlier version of
  // this fix used [0x2600,0x27bf] wholesale and incorrectly widened text-
  // default symbols like ⚠ too. This list covers the block's commonly-used
  // status/checkmark/star glyphs -- ✅ (U+2705), ❌ (U+274C), ⭐ (U+2B50),
  // ☑ (U+2611), and neighbors -- which is one of the most likely subsets an
  // LLM-generated status table actually uses. Not exhaustive UAX #11 or
  // Emoji_Presentation coverage of the block, same practical,
  // terminal-observed-subset approach as the rest of this table.
  [0x2611, 0x2611], // ballot box with check (☑)
  [0x2614, 0x2615], // umbrella with rain drops, hot beverage
  [0x2648, 0x2653], // zodiac signs
  [0x2693, 0x2693], // anchor
  [0x26a1, 0x26a1], // high voltage
  [0x26aa, 0x26ab], // circles (white/black)
  [0x26bd, 0x26be], // soccer ball, baseball
  [0x26c4, 0x26c5], // snowman without snow, sun behind cloud
  [0x26ce, 0x26ce], // ophiuchus
  [0x26d4, 0x26d4], // no entry
  [0x26ea, 0x26ea], // church
  [0x26f2, 0x26f3], // fountain, flag in hole
  [0x26f5, 0x26f5], // sailboat
  [0x26fa, 0x26fa], // tent
  [0x26fd, 0x26fd], // fuel pump
  [0x2705, 0x2705], // check mark button (✅)
  [0x270a, 0x270b], // raised fist, raised hand
  [0x2728, 0x2728], // sparkles
  [0x274c, 0x274c], // cross mark (❌)
  [0x274e, 0x274e], // cross mark button
  [0x2753, 0x2755], // question/exclamation marks
  [0x2757, 0x2757], // heavy exclamation mark
  [0x2795, 0x2797], // plus/minus/division
  [0x27b0, 0x27b0], // curly loop
  [0x27bf, 0x27bf], // double curly loop
  [0x2b1b, 0x2b1c], // large squares (black/white)
  [0x2b50, 0x2b50], // star (⭐)
  [0x2b55, 0x2b55], // heavy large circle
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

/**
 * Estimates how many terminal rows a fixed piece of hint/footer text wraps
 * to inside a box `innerWidth` display columns wide.
 *
 * This is deliberately not a real text-layout engine -- Ink/Yoga wrap on
 * whitespace like a terminal does, and reproducing that exactly would need
 * to know the actual word-break points. What every row-budget calculation
 * in the canvases actually needs is just the row *count* a known, fixed
 * hint string will cost, so it can reserve that many rows instead of
 * silently assuming one. A ceil-of-division estimate is exact for the
 * common cases (comfortably fits in one line at the terminal's default 80
 * columns, or overflows by roughly a multiple of the available width at a
 * narrow one) and, on the rare word-break edge case where actual wrapping
 * costs one row more than this predicts, still gets the reservation much
 * closer than treating every footer as one line.
 */
export function wrappedLineCount(text: string, innerWidth: number): number {
  if (innerWidth <= 0) return 1;
  return Math.max(1, Math.ceil(displayWidth(text) / innerWidth));
}
