import { test, expect } from "bun:test";
import { displayWidth, truncateToWidth, padToWidth } from "./width";

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

test("padToWidth pads to display columns, not code units", () => {
  expect(displayWidth(padToWidth(cp(0x65e5), 4))).toBe(4);
  expect(displayWidth(padToWidth(FAMILY, 6))).toBe(6);
  // Already at or over width: left alone rather than truncated.
  expect(padToWidth(CJK_FIRST_TWO, 4)).toBe(CJK_FIRST_TWO);
  expect(padToWidth(CJK, 4)).toBe(CJK);
});
