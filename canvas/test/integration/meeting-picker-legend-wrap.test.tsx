import { test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { FIXED_CLOCK } from "../fixtures/configs";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

// Regression tests for the bug this wave fixes: meeting-picker-view.tsx
// hardcoded `headerHeight = 5`, assuming the calendar-name legend
// (renderLegend) always renders as exactly 1 line. With enough calendars, or
// long enough names, Ink wraps the legend onto 2 lines -- but gridTop /
// terminalToSlot (the mouse-to-slot mapping) kept assuming the old, smaller
// header height, so a click on the row VISIBLY showing e.g. "6am" booked the
// WRONG slot (one slot later than the one under the pointer). Both repro
// widths from the bug report are covered: 70 columns / 5 full names, and 80
// columns / 6 full names.
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

const FIVE_FULL_NAMES = [
  { name: "Alexandra Montgomery", color: "cyan" },
  { name: "Bartholomew Fitzgerald", color: "blue" },
  { name: "Christopher Wellington", color: "green" },
  { name: "Dominique Alexander", color: "yellow" },
  { name: "Evangeline Rutherford", color: "magenta" },
];

const SIX_FULL_NAMES = [
  ...FIVE_FULL_NAMES,
  { name: "Frederickson Abernathy", color: "red" },
];

function mount(id: string, calendars: { name: string; color: string }[], size: { columns: number; rows: number }) {
  ids.push(id);
  return renderCanvas(
    <Calendar
      id={id}
      config={{
        calendars: calendars.map((c) => ({ name: c.name, color: c.color, events: [] })),
        slotGranularity: 30,
      }}
      enabled={true}
      scenario="meeting-picker"
    />,
    size
  );
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

// Ink's frames carry ANSI color codes (FORCE_COLOR=1 is pinned for the whole
// suite -- see test/setup.ts), which break naive substring/word-boundary
// matching: e.g. "\x1b[90mTue" has no \b between the escape code's trailing
// "m" and "T" (both are word characters), so a raw `/\bTue\b/` silently
// fails to match a colored frame. Strip codes before any text search below.
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Finds the 1-based terminal row of the line containing `needle` in the most
// recent frame -- Ink's frame is one string with embedded newlines, one
// terminal row per line, and mouse y-coordinates (SGR protocol) are 1-based.
function rowOf(frame: string, needle: string): number {
  const lines = stripAnsi(frame).split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`"${needle}" not found in frame:\n${frame}`);
  return idx + 1;
}

async function verifyClickOnSixAmRowBooksSixAm(
  id: string,
  calendars: { name: string; color: string }[],
  size: { columns: number; rows: number }
) {
  const r = mount(id, calendars, size);
  const frame = await r.settle();
  await awaitRecord(id, 5000);

  // Confirm this scenario really does reproduce the wrap this fix targets:
  // the legend must actually occupy 2+ lines at this width, otherwise the
  // test would pass even with the old hardcoded headerHeight=5.
  const firstName = calendars[0]!.name.split(" ")[0]!;
  const lines = stripAnsi(frame).split("\n");
  const legendLineIdx = lines.findIndex((l) => l.includes(firstName));
  expect(legendLineIdx).toBeGreaterThanOrEqual(0);
  // Matches the day-headers row specifically (both "Mon" AND "Tue" appear,
  // space-delimited) -- a plain `includes("Mon")` false-matches the legend
  // line itself, since "Montgomery" contains "Mon" as a substring.
  const dayHeaderLineIdx = lines.findIndex((l) => /\bMon\b/.test(l) && /\bTue\b/.test(l));
  expect(dayHeaderLineIdx).toBeGreaterThan(legendLineIdx + 1); // legend spans 2+ lines

  // The cursor readout and the footer's key hints must both survive intact
  // -- the header/footer mismatch used to shift the grid tall enough to
  // overwrite the footer's "q quit" hint. Checked BEFORE the click below:
  // a successful click legitimately replaces the footer with a "confirm"
  // countdown, which is not the bug this asserts against.
  expect(frame).toContain("q quit");

  // The row that visibly shows "6am" is where a click must book 6:00, not
  // 6:30 (the old bug) and not fall on some other slot.
  const sixAmRow = rowOf(frame, "6am");
  const gridLeft = 6 + 2; // timeColumnWidth + paddingX, same as meeting-picker-view.tsx
  const x = gridLeft + 2; // safely inside Monday's column

  const conn = await openConnection(id);
  r.stdin.write(`\x1b[<0;${x};${sixAmRow}M`);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).not.toBeNull();
  const { startTime } = (msg as { data: { startTime: string } }).data;
  const clicked = new Date(startTime);
  expect(clicked.getHours()).toBe(6);
  expect(clicked.getMinutes()).toBe(0);

  conn.close();
  r.dispose();
}

test("70 columns, 5 full calendar names: clicking the row showing 6am books 6:00, not 6:30", async () => {
  await verifyClickOnSixAmRowBooksSixAm("mplw-70-5", FIVE_FULL_NAMES, { columns: 70, rows: 18 });
});

test("80 columns, 6 full calendar names: clicking the row showing 6am books 6:00, not 6:30", async () => {
  await verifyClickOnSixAmRowBooksSixAm("mplw-80-6", SIX_FULL_NAMES, { columns: 80, rows: 18 });
});

// A single short calendar name still fits on one line, so headerHeight must
// stay exactly what it always was for that case -- this fix must not change
// behavior when the legend genuinely is 1 line.
test("a single short calendar name (1-line legend) still books the row shown as 6am at 6:00", async () => {
  const id = "mplw-single-short";
  const r = mount(id, [{ name: "Ana", color: "cyan" }], { columns: 70, rows: 18 });
  const frame = await r.settle();
  await awaitRecord(id, 5000);

  const lines = stripAnsi(frame).split("\n");
  const legendLineIdx = lines.findIndex((l) => l.includes("Ana"));
  // Matches the day-headers row specifically (both "Mon" AND "Tue" appear,
  // space-delimited) -- a plain `includes("Mon")` false-matches the legend
  // line itself, since "Montgomery" contains "Mon" as a substring.
  const dayHeaderLineIdx = lines.findIndex((l) => /\bMon\b/.test(l) && /\bTue\b/.test(l));
  // Exactly 1 line of legend before the day-header row.
  expect(dayHeaderLineIdx).toBe(legendLineIdx + 1);

  const sixAmRow = rowOf(frame, "6am");
  const conn = await openConnection(id);
  r.stdin.write(`\x1b[<0;10;${sixAmRow}M`);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  const { startTime } = (msg as { data: { startTime: string } }).data;
  const clicked = new Date(startTime);
  expect(clicked.getHours()).toBe(6);
  expect(clicked.getMinutes()).toBe(0);

  conn.close();
  r.dispose();
});

// Fix 5's companion bug in the same click-mapping code: a click below the
// actual rendered grid (e.g. on the help/footer bar) used to fall through to
// booking the LAST visible slot instead of being recognized as outside the
// grid. Click far below the grid's real bottom and confirm nothing is
// booked.
test("clicking below the grid (on the help bar) books nothing", async () => {
  const id = "mplw-below-grid";
  const r = mount(id, FIVE_FULL_NAMES, { columns: 70, rows: 18 });
  await r.settle();
  await awaitRecord(id, 5000);

  const conn = await openConnection(id);
  // Row 18 is the last row of an 18-row pane -- the help bar, well past the
  // grid's real bottom.
  r.stdin.write("\x1b[<0;10;18M");
  await r.settle();

  const msg = await nextOutcome(conn, 500);
  expect(msg).toBeNull();

  conn.close();
  r.dispose();
});
