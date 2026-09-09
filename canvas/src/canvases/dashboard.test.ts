import { test, expect } from "bun:test";
import { allocateRows } from "./dashboard";
import type { DashboardRegion } from "./dashboard/types";

// `allocateRows` had zero direct tests before this file (per an independent
// review of this fix wave) -- it was only ever exercised indirectly through
// full Dashboard renders, which can hide an off-by-one in the remainder
// distribution behind a snapshot that still "looks right".

function region(id: string, rows?: number): DashboardRegion {
  return { id, kind: "text", rows, config: { text: "" } };
}

test("regions that all omit rows split the budget evenly", () => {
  const regions = [region("a"), region("b"), region("c")];
  expect(allocateRows(regions, 30)).toEqual([10, 10, 10]);
});

test("a remainder that doesn't divide evenly goes to the earliest regions, one row each", () => {
  const regions = [region("a"), region("b"), region("c")];
  // 20 / 3 = 6 remainder 2 -- the first two regions get the extra row.
  expect(allocateRows(regions, 20)).toEqual([7, 7, 6]);
});

test("fixed-height regions get exactly what they asked for", () => {
  const regions = [region("a", 5), region("b", 8)];
  expect(allocateRows(regions, 13)).toEqual([5, 8]);
});

test("a mix of fixed and flexible regions: fixed get theirs, flexible split the rest", () => {
  const regions = [region("a", 6), region("b"), region("c")];
  // Budget 20, 6 spent on "a", 14 left split between "b" and "c".
  expect(allocateRows(regions, 20)).toEqual([6, 7, 7]);
});

// The docstring on allocateRows is explicit that no region goes below
// MIN_REGION_ROWS (3) even if that overflows the given budget -- a region
// too short to draw its own border is worse than a pane that scrolls.
test("a flexible region never drops below the 3-row minimum, even if that overflows the budget", () => {
  const regions = [region("a"), region("b"), region("c"), region("d"), region("e")];
  // Budget 10 split 5 ways would be 2 each; every region is floored to 3,
  // so the total (15) legitimately exceeds the 10-row budget passed in.
  const heights = allocateRows(regions, 10);
  expect(heights).toEqual([3, 3, 3, 3, 3]);
  expect(heights.every((h) => h >= 3)).toBe(true);
});

test("a fixed height below the 3-row minimum is still floored to 3", () => {
  // validateDashboard rejects an explicit `rows` below 3 before this ever
  // runs in production, but allocateRows enforces its own floor
  // independently rather than trusting the caller.
  const regions = [region("a", 1)];
  expect(allocateRows(regions, 10)).toEqual([3]);
});

test("a single flexible region gets the whole budget", () => {
  expect(allocateRows([region("solo")], 12)).toEqual([12]);
});

// Harder variant: an uneven remainder across MORE regions than fit neatly,
// checked for total-adds-up-exactly -- the docstring's central claim.
test("heights sum to the budget when every region is flexible and the budget clears the minimum", () => {
  const regions = Array.from({ length: 7 }, (_, i) => region(`r${i}`));
  const budget = 100;
  const heights = allocateRows(regions, budget);
  expect(heights.reduce((a, b) => a + b, 0)).toBe(budget);
  expect(heights).toEqual([15, 15, 14, 14, 14, 14, 14]);
});
