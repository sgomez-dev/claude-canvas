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
