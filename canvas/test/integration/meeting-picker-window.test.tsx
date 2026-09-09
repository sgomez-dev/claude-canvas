import { test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { meetingPickerConfig, FIXED_CLOCK } from "../fixtures/configs";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

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

// A 6:00-22:00 day at 30-minute granularity is 32 slots. At 70x18 the
// vertical budget is 11 rows, and the grid used to render all 32 anyway --
// `Math.max(1, floor(11 / 32))` forced one row each -- so Ink drew them on
// top of the help bar and the cursor readout overwrote the key hints.
const SMALL = { columns: 70, rows: 18 };

function mount(id: string, size = SMALL, enabled = false) {
  if (enabled) ids.push(id);
  return renderCanvas(
    <Calendar id={id} config={meetingPickerConfig} enabled={enabled} scenario="meeting-picker" />,
    size
  );
}

test("a grid taller than the pane shows a window, and says which", async () => {
  const r = mount("mpw-1");
  const frame = await r.settle();
  // 11 visible slots of 30 minutes, starting at 06:00.
  expect(frame).toContain("06:00-11:30");
  // The help hints and the cursor readout both survive intact, which is the
  // overlap this fixes.
  expect(frame).toContain("q quit");
  expect(frame).toContain("06:00 - 06:30");
  r.dispose();
});

test("moving the cursor past the window pages the grid", async () => {
  const r = mount("mpw-2");
  expect(await r.settle()).toContain("06:00-11:30");

  // Ten moves stay inside the first window of eleven slots.
  for (let i = 0; i < 10; i++) {
    r.stdin.write("\x1b[B");
    await r.settle();
  }
  expect(await r.settle()).toContain("06:00-11:30");

  // The eleventh crosses the boundary.
  r.stdin.write("\x1b[B");
  const frame = await r.settle();
  expect(frame).toContain("11:30-17:00");
  expect(frame).toContain("11:30 - 12:00"); // readout follows the cursor
  r.dispose();
});

test("a pane tall enough for every slot shows no window label", async () => {
  // 32 slots plus 7 rows of chrome; 44 rows is comfortably enough.
  const r = mount("mpw-3", { columns: 70, rows: 44 });
  const frame = await r.settle();
  expect(frame).not.toContain("06:00-11:30");
  expect(frame).toContain("q quit");
  r.dispose();
});

// The mouse maps a pixel row to a slot, so it has to add the window offset
// too. Without that, clicking the top of a paged grid would silently book
// the wrong time -- the worst possible outcome for this canvas.
test("a click maps to the visible slot, not the same offset from midnight", async () => {
  const id = "mpw-click";
  const r = mount(id, SMALL, true);
  await r.settle();
  expect(await awaitRecord(id, 5000)).not.toBeNull();

  // Page to the second window, which starts at slot 11 (11:30).
  for (let i = 0; i < 11; i++) {
    r.stdin.write("\x1b[B");
    await r.settle();
  }
  expect(await r.settle()).toContain("11:30-17:00");

  const conn = await openConnection(id);

  // SGR press at the first grid row of the first day column. gridTop is
  // headerHeight + 1 = 6 and gridLeft is timeColumnWidth + 2 = 8, both
  // 1-based, so (10, 6) is Monday's topmost visible slot.
  r.stdin.write("\x1b[<0;10;6M");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).not.toBeNull();
  const { startTime } = (msg as { data: { startTime: string } }).data;
  const clicked = new Date(startTime);
  // 11:30 -- the top of the WINDOW -- not 06:00, the top of the day.
  expect(clicked.getHours()).toBe(11);
  expect(clicked.getMinutes()).toBe(30);

  conn.close();
  r.dispose();
});

// Regression test for the mis-booking bug the windowing fix above
// introduced on the CAPPED last page specifically.
//
// 32 slots, 11 visible: page 0 is slots 0-10, page 1 is slots 11-21, and
// the LAST page is capped to slots 21-31 (windowStart = 21, not 22 -- 22
// would be the next multiple of 11, but that would run past slot 31).
// Slot 21 therefore sits in BOTH page 1's uncapped floor-division range
// (11-21) and the actual capped last page (21-31) that's on screen once
// you've paged all the way down -- it's the one absolute slot index the
// two formulas disagree about.
//
// windowStart used to be re-derived from cursorSlot on every render via
// plain floor-division capped for the last page. A mouse hover sets
// cursorSlot to whatever's under the pointer, so hovering over slot 21
// while page 2 (windowStart=21) was on screen fed 21 back through that
// formula and got windowStart=11 (page 1) instead -- the grid silently
// re-paged with no mouse movement, and a click at the same pixel then
// booked whatever was now under it in page 1: 11:30, five hours off from
// the 16:30 actually on screen. This is the exact repro from the bug
// report ("booked a time 5 hours different from what was on screen").
test("hovering a slot on the CAPPED last page does not silently re-page the grid", async () => {
  const id = "mpw-capped";
  const r = mount(id, SMALL, true);
  await r.settle();
  expect(await awaitRecord(id, 5000)).not.toBeNull();

  // Page all the way down to the last (capped) page: 22 presses lands the
  // cursor on slot 22, the first slot of the capped last window.
  for (let i = 0; i < 22; i++) {
    r.stdin.write("\x1b[B");
    await r.settle();
  }
  const beforeHover = await r.settle();
  // windowStart = 21 (capped), not 22 (the uncapped multiple of 11) --
  // 6:00 + 21 * 30min = 16:30, running to 6:00 + 32 * 30min = 22:00.
  expect(beforeHover).toContain("16:30-22:00");

  const conn = await openConnection(id);

  // Motion event (no button), at the TOP grid row -- gridTop=6, gridLeft=8
  // (same as the click test above) -- which maps to slot 21, the ambiguous
  // one: visible on the capped last page, but NOT where plain
  // floor-division would put it if windowStart were re-derived from it.
  r.stdin.write("\x1b[<35;10;6M");
  const afterHover = await r.settle();

  // The window must NOT have changed just because the mouse hovered over a
  // slot that was already visible on it.
  expect(afterHover).toContain("16:30-22:00");

  // A click at that same pixel must book what was actually on screen
  // there (16:30), not whatever the old buggy re-paged window would put
  // under that pixel (11:30 -- five hours off).
  r.stdin.write("\x1b[<0;10;6M");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).not.toBeNull();
  const { startTime } = (msg as { data: { startTime: string } }).data;
  const clicked = new Date(startTime);
  expect(clicked.getHours()).toBe(16);
  expect(clicked.getMinutes()).toBe(30);

  conn.close();
  r.dispose();
});
