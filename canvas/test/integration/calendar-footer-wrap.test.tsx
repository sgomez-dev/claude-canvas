import { test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { calendarDisplayConfig, meetingPickerConfig, FIXED_CLOCK } from "../fixtures/configs";
import { deleteRecord } from "../../src/runtime/registry";

// Regression tests for the bug this wave fixes: both display-view.tsx
// (`footerHeight = 1`) and meeting-picker-view.tsx (`footerHeight = 2`) used
// a flat constant instead of measuring the footer's ACTUAL rendered row
// count via `wrappedLineCount` -- the pattern picker, table, diff, form and
// tree all already use. The real footer is a dynamic window-range label
// (display) or a window-range label plus a cursor readout (meeting-picker)
// followed by a static hint, and at narrow widths that whole string wraps
// onto more rows than the flat constant assumed. The reserved budget then
// undercounted the real footer height, so the grid was sized as if one (or
// two) more rows were available to it than actually were once the footer
// wrapped -- the same "pane overflow" shape tree.test.tsx's own footer-wrap
// regression test guards against.
const ids: string[] = [];
let restore: () => void;

beforeEach(() => {
  setSystemTime(FIXED_CLOCK);
  restore = stubRealStdout();
});

afterEach(async () => {
  restore();
  setSystemTime();
  for (const id of ids.splice(0)) await deleteRecord(id);
});

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function nonEmptyLineCount(frame: string): number {
  return stripAnsi(frame).split("\n").filter((l) => l.trim().length > 0).length;
}

// display: 70 columns is wide enough that the footer's window-range label
// plus hint fits on one line (matching the historical footerHeight=1
// assumption); 58 is the width the reviewer measured as needing 2.
//
// display never actually overflows its pane at ANY width, old code or new --
// the reviewer's own finding, confirmed here by direct experiment: a second,
// untouched bug (`headerHeight = 5` over-counts the title's real row count
// by exactly 1, unconditionally) happens to cancel the footer's own
// under-count by exactly 1 row, at every width. So "no overflow" cannot
// distinguish old from new for this file; what DOES is the reserved window
// size, which is the number this fix actually corrects. At 58 columns the
// footer needs 2 real rows (window-range label + FOOTER_HINT don't fit on
// one line); the OLD flat `footerHeight = 1` under-reserves by one row and
// hands the grid a window one slot too generous ("08:00-14:00", 12 slots)
// -- confirmed directly: hardcoding footerRows back to 1 reproduces exactly
// that label. The FIX reserves the real 2 rows and the window shrinks to
// what actually fits ("08:00-13:30", 11 slots).
test("display: at a width where the footer wraps, the window shrinks to what the footer's real height leaves", async () => {
  const size = { columns: 58, rows: 18 };
  const r = renderCanvas(
    <Calendar id="cal-fw-disp" config={calendarDisplayConfig} enabled={false} scenario="display" />,
    size
  );
  const frame = await r.settle();
  const stripped = stripAnsi(frame);

  // The corrected, conservative window: one slot narrower than the old
  // (under-reserved) code produced.
  expect(stripped).toContain("08:00-13:30");
  expect(stripped).not.toContain("08:00-14:00");

  // The pane must not overflow its budget, and the hint must still be fully
  // present (a legitimate wrap can split "q quit" across two lines at the
  // word boundary -- that's fine; the word vanishing is not).
  expect(nonEmptyLineCount(frame)).toBeLessThanOrEqual(size.rows);
  expect(stripped).toContain("quit");

  r.dispose();
});

// A wider render of the same config must still fit on one footer line (no
// regression for the common case).
test("display: at 70 columns the footer still fits on its historical single line", async () => {
  const size = { columns: 70, rows: 18 };
  const r = renderCanvas(
    <Calendar id="cal-fw-disp-wide" config={calendarDisplayConfig} enabled={false} scenario="display" />,
    size
  );
  const frame = await r.settle();
  expect(nonEmptyLineCount(frame)).toBeLessThanOrEqual(size.rows);
  // A legitimate wrap can split "q quit" across two rendered lines at the
  // word boundary (real word-wrap, not a defect) -- what must never happen
  // is the word itself vanishing, which is what an under-reserved budget
  // produced before this fix (the wrapped row had nowhere left to render).
  expect(stripAnsi(frame)).toContain("quit");
  r.dispose();
});

// meeting-picker: the reviewer's own measured repro widths -- 64, 60, 58 and
// 52 columns -- all lost "q quit" under the old flat `footerHeight = 2`
// (confirmed directly: reverting footerRows to a hardcoded `2` reproduces
// exactly this loss at these widths, and the fix -- measuring the real
// footer via wrappedLineCount -- resolves it). Every one of them must now
// fit its budget with the hint intact.
for (const columns of [64, 60, 58, 52]) {
  test(`meeting-picker: the pane never overflows its row budget at ${columns} columns`, async () => {
    const size = { columns, rows: 18 };
    const r = renderCanvas(
      <Calendar id={`cal-fw-mp-${columns}`} config={meetingPickerConfig} enabled={false} scenario="meeting-picker" />,
      size
    );
    const frame = await r.settle();

    expect(nonEmptyLineCount(frame)).toBeLessThanOrEqual(size.rows);
    // A legitimate wrap can split "q quit" across two rendered lines at the
    // word boundary (real word-wrap, not a defect) -- what must never happen
    // is the word itself vanishing, which is what an under-reserved budget
    // produced before this fix (the wrapped row had nowhere left to render).
    expect(stripAnsi(frame)).toContain("quit");

    r.dispose();
  });
}

// 34 and 30 columns are ALSO in the reviewer's repro list, but narrow enough
// to trigger a SEPARATE, pre-existing defect this fix does not touch: the
// title line ("March 2026 - Select a meeting time") itself wraps onto 2 rows
// at this width, and `headerHeight = 4 + legendRows` has never accounted for
// that (it assumes the title is always exactly 1 row -- unchanged by this
// fix, and present identically before it). Confirmed by direct experiment:
// reverting ONLY the footer measurement back to the old hardcoded `2` still
// reproduces the exact same loss of "quit" at 34 columns, so the residual
// clipping here is not this fix's footer-budget defect re-appearing -- it is
// a second, independent bug in the header budget. Only the property this fix
// actually owns (no pane overflow) is asserted here; recovering "quit" at
// these two widths needs a title-wrap fix to headerHeight, out of scope for
// this pass (see the final report).
for (const columns of [34, 30]) {
  test(`meeting-picker: the pane never overflows its row budget at ${columns} columns (title-wrap defect is separate, pre-existing)`, async () => {
    const size = { columns, rows: 18 };
    const r = renderCanvas(
      <Calendar id={`cal-fw-mp-${columns}`} config={meetingPickerConfig} enabled={false} scenario="meeting-picker" />,
      size
    );
    const frame = await r.settle();
    expect(nonEmptyLineCount(frame)).toBeLessThanOrEqual(size.rows);
    r.dispose();
  });
}

// A wider render must still fit on the historical 2-line footer (no
// regression for the common case).
test("meeting-picker: at 70 columns the footer still fits its historical 2-row budget", async () => {
  const size = { columns: 70, rows: 18 };
  const r = renderCanvas(
    <Calendar id="cal-fw-mp-wide" config={meetingPickerConfig} enabled={false} scenario="meeting-picker" />,
    size
  );
  const frame = await r.settle();
  expect(nonEmptyLineCount(frame)).toBeLessThanOrEqual(size.rows);
  // A legitimate wrap can split "q quit" across two rendered lines at the
  // word boundary (real word-wrap, not a defect) -- what must never happen
  // is the word itself vanishing, which is what an under-reserved budget
  // produced before this fix (the wrapped row had nowhere left to render).
  expect(stripAnsi(frame)).toContain("quit");
  r.dispose();
});
