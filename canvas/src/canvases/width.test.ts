import { test, expect } from "bun:test";
import {
  displayWidth,
  truncateToWidth,
  truncateToWidthFromEnd,
  padToWidth,
  wrappedLineCount,
} from "./width";

// Fixtures are built from code points rather than written as literals. Half
// of these characters are invisible, zero-width, or indistinguishable from
// their composed form, so a literal would be a fixture nobody can review --
// and this is a test about code points in the first place.
const cp = (...points: number[]) => String.fromCodePoint(...points);

const CJK = cp(0x65e5, 0x672c, 0x8a9e); // three ideographs, 6 columns
const CJK_FIRST_TWO = cp(0x65e5, 0x672c);
const ROCKET = cp(0x1f680);
const ZWJ = cp(0x200d);
const FAMILY = [0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466]
  .map((c) => cp(c))
  .join("");
const FLAG_ES = cp(0x1f1ea, 0x1f1f8);
const FLAG_JP = cp(0x1f1ef, 0x1f1f5);
const E_COMPOSED = cp(0x00e9); // e-acute as one code point
const E_DECOMPOSED = "e" + cp(0x0301); // e + combining acute
const WARNING = cp(0x26a0); // no presentation selector
const WARNING_EMOJI = WARNING + cp(0xfe0f);
const FULLWIDTH_AB = cp(0xff21, 0xff22);
const ZWSP = cp(0x200b);
const SOH = cp(0x01);

test("ASCII is one column per character", () => {
  expect(displayWidth("")).toBe(0);
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth("a b")).toBe(3);
});

// The three cases String.length got wrong, which is why any table row
// containing one of them misaligned.
test("CJK is two columns per ideograph, not one per code unit", () => {
  expect(CJK.length).toBe(3); // what the old code counted
  expect(displayWidth(CJK)).toBe(6);
});

test("an astral emoji is two columns, not two code units", () => {
  expect(ROCKET.length).toBe(2);
  expect(displayWidth(ROCKET)).toBe(2);
});

test("a ZWJ family emoji is two columns, not eleven code units", () => {
  expect(FAMILY.length).toBe(11); // what the old code counted
  expect(displayWidth(FAMILY)).toBe(2);
});

test("a regional-indicator flag is one cluster of two columns", () => {
  expect(displayWidth(FLAG_ES)).toBe(2);
  expect(displayWidth(FLAG_ES + FLAG_JP)).toBe(4);
});

test("a combining mark adds no columns", () => {
  expect(E_DECOMPOSED.length).toBe(2);
  expect(displayWidth(E_COMPOSED)).toBe(1);
  expect(displayWidth(E_DECOMPOSED)).toBe(1);
});

// U+FE0F asks for emoji presentation, which renders double-width even when
// the base character alone would not.
test("an emoji presentation selector makes its base double-width", () => {
  expect(displayWidth(WARNING)).toBe(1);
  expect(displayWidth(WARNING_EMOJI)).toBe(2);
});

test("fullwidth forms are two columns", () => {
  expect(displayWidth(FULLWIDTH_AB)).toBe(4);
});

test("control and zero-width characters occupy no columns", () => {
  expect(displayWidth("a" + SOH + "b")).toBe(2);
  expect(displayWidth("a" + ZWSP + "b")).toBe(2);
  expect(displayWidth("a" + ZWJ + "b")).toBe(2);
});

test("truncateToWidth never splits a double-width character", () => {
  // Cutting at 5 columns must yield two ideographs (4 columns), not half of
  // the third -- half a character shifts every column after it.
  expect(truncateToWidth(CJK, 5)).toBe(CJK_FIRST_TWO);
  expect(displayWidth(truncateToWidth(CJK, 5))).toBe(4);
  expect(truncateToWidth(CJK, 6)).toBe(CJK);
});

test("truncateToWidth never splits a grapheme cluster", () => {
  expect(truncateToWidth("a" + FAMILY, 2)).toBe("a");
  expect(truncateToWidth("a" + FAMILY, 3)).toBe("a" + FAMILY);
});

test("truncateToWidth handles degenerate widths", () => {
  expect(truncateToWidth("abc", 0)).toBe("");
  expect(truncateToWidth("abc", -1)).toBe("");
  expect(truncateToWidth(cp(0x65e5), 1)).toBe("");
});

// Used by form/view.tsx's textarea, which always shows the tail of what was
// typed (the cursor only ever appends), so it needs the opposite end kept
// compared to truncateToWidth.
test("truncateToWidthFromEnd keeps the tail, not the head", () => {
  expect(truncateToWidthFromEnd("abcdef", 3)).toBe("def");
  expect(truncateToWidthFromEnd("abcdef", 6)).toBe("abcdef");
  expect(truncateToWidthFromEnd("abcdef", 100)).toBe("abcdef");
});

test("truncateToWidthFromEnd never splits a double-width character", () => {
  // Cutting at 5 columns from a 6-column, 3-ideograph string must yield the
  // LAST two ideographs (4 columns), not half of the first-kept one.
  const CJK_LAST_TWO = cp(0x672c, 0x8a9e);
  expect(truncateToWidthFromEnd(CJK, 5)).toBe(CJK_LAST_TWO);
  expect(displayWidth(truncateToWidthFromEnd(CJK, 5))).toBe(4);
  expect(truncateToWidthFromEnd(CJK, 6)).toBe(CJK);
});

test("truncateToWidthFromEnd never splits a grapheme cluster", () => {
  expect(truncateToWidthFromEnd(FAMILY + "a", 2)).toBe("a");
  expect(truncateToWidthFromEnd(FAMILY + "a", 3)).toBe(FAMILY + "a");
});

test("truncateToWidthFromEnd handles degenerate widths", () => {
  expect(truncateToWidthFromEnd("abc", 0)).toBe("");
  expect(truncateToWidthFromEnd("abc", -1)).toBe("");
  expect(truncateToWidthFromEnd(cp(0x65e5), 1)).toBe("");
});

// Regression tests for Fix 6: the width table had no entry for the
// U+2600-U+2BFF range (Miscellaneous Symbols, Dingbats, Miscellaneous
// Symbols and Arrows), which includes some of the single most likely
// characters an LLM would put in a generated status table. These measured
// as width 1 before the fix, but every real terminal renders them as width
// 2, causing real column misalignment in any table containing one.
const CHECK_MARK = cp(0x2705); // ✅
const CROSS_MARK = cp(0x274c); // ❌
const STAR = cp(0x2b50); // ⭐
const WATCH = cp(0x231a); // ⌚
const BALLOT_BOX_CHECK = cp(0x2611); // ☑

test("common status emoji (✅ ❌ ⭐ ⌚ ☑) measure as width 2", () => {
  expect(displayWidth(CHECK_MARK)).toBe(2);
  expect(displayWidth(CROSS_MARK)).toBe(2);
  expect(displayWidth(STAR)).toBe(2);
  expect(displayWidth(WATCH)).toBe(2);
  expect(displayWidth(BALLOT_BOX_CHECK)).toBe(2);
});

test("padToWidth pads to display columns, not code units", () => {
  expect(displayWidth(padToWidth(cp(0x65e5), 4))).toBe(4);
  expect(displayWidth(padToWidth(FAMILY, 6))).toBe(6);
  // Already at or over width: left alone rather than truncated.
  expect(padToWidth(CJK_FIRST_TWO, 4)).toBe(CJK_FIRST_TWO);
  expect(padToWidth(CJK, 4)).toBe(CJK);
});

test("wrappedLineCount is 1 when the text fits within the width", () => {
  expect(wrappedLineCount("short", 80)).toBe(1);
  expect(wrappedLineCount("exactly ten", 11)).toBe(1);
});

test("wrappedLineCount counts additional rows once the text exceeds the width", () => {
  expect(wrappedLineCount("a".repeat(56), 56)).toBe(1);
  expect(wrappedLineCount("a".repeat(57), 56)).toBe(2);
  expect(wrappedLineCount("a".repeat(112), 56)).toBe(2);
  expect(wrappedLineCount("a".repeat(113), 56)).toBe(3);
});

test("wrappedLineCount never returns less than 1, even for a degenerate width", () => {
  expect(wrappedLineCount("anything", 0)).toBe(1);
  expect(wrappedLineCount("anything", -5)).toBe(1);
  expect(wrappedLineCount("", 80)).toBe(1);
});

// Regression for Fix 3: a ceil-of-division estimate under-counts real
// greedy word-wrap, which breaks only at word boundaries -- a long word
// that would overflow the remaining space on a line is pushed onto a fresh
// one instead of being packed in right up to the edge. diff/view.tsx's own
// 77-column footer hint at 40 terminal columns is the case the independent
// review reproduced this with: the division estimated 2 rows, but real
// Ink/terminal wrapping actually produces 3. Confirmed by rendering the
// exact same string through Ink in a Box of each width (see the git history
// of this test for the harness used to verify it) -- these numbers are not
// guesses.
const DIFF_FOOTER_HINT =
  "a/r: approve/reject  ↑/↓: hunk  PgUp/PgDn: scroll  Enter: submit  Esc: cancel";

test("wrappedLineCount matches real greedy word-wrap for diff's footer hint", () => {
  expect(displayWidth(DIFF_FOOTER_HINT)).toBe(77);
  // The reproduced regression case: the old ceil-of-division estimate said
  // 2 here; real Ink wrapping (and the fixed estimate) says 3.
  expect(wrappedLineCount(DIFF_FOOTER_HINT, 40)).toBe(3);
  // Narrower still -- verified against real Ink rendering too.
  expect(wrappedLineCount(DIFF_FOOTER_HINT, 20)).toBe(5);
});

// The doubled space between clauses ("reject  ↑/↓") is a real, deliberate
// part of these hint strings, and a wrap estimate that collapsed every gap
// to a single assumed column would under-measure it: the difference
// between a one- and two-column gap is exactly what decides whether the
// next word still fits on the current line.
test("wrappedLineCount treats a doubled space as two columns, not one", () => {
  // "aaaa" + "  " (2) + "bbbb" = 10 columns exactly at width 10 with a
  // single-column gap, but this codebase's hints use a double-space
  // separator, which pushes "bbbb" over by one column and forces a wrap.
  expect(wrappedLineCount("aaaa  bbbb", 9)).toBe(2);
  expect(wrappedLineCount("aaaa  bbbb", 10)).toBe(1);
});

// A single word wider than the entire available width can never be pushed
// onto a fresh line and still fit -- real word-wrap hard-breaks it instead
// of leaving it to overflow, so the estimate must too.
test("wrappedLineCount hard-wraps a single word wider than the available width", () => {
  expect(wrappedLineCount("supercalifragilisticexpialidocious", 10)).toBe(
    Math.ceil(displayWidth("supercalifragilisticexpialidocious") / 10)
  );
  // Mixed with normal words on either side: the oversized word still
  // forces its own hard-wrapped run, and a normal word after it starts
  // fresh rather than trying to continue on the oversized word's last
  // partial line unless it happens to fit.
  const text = "short " + "x".repeat(25) + " short";
  // "short" (5) fits on line 1 alone; the 25-wide unbreakable word can't
  // follow it (5+1+25=31 > 10), so it starts its own line(s): ceil(25/10)=3
  // lines, ending with a 5-column remainder; the trailing "short" (5) then
  // fits on that same remainder line (5+1+5=11 > 10 -- doesn't fit, so it
  // gets its own line too).
  expect(wrappedLineCount(text, 10)).toBe(1 + 3 + 1);
});
