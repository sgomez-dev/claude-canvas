import { test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { FIXED_CLOCK } from "../fixtures/configs";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";

// Regression tests for the bug this wave fixes: calendar.tsx's `display`
// scenario hardcoded `headerHeight = 5`, which had NO term at all for the
// all-day-events row -- AllDayEventsRow renders one Box per event (not one
// shared row for all of them), so a day with 3 all-day events makes the
// whole row 3 rows tall. With the old hardcoded height, that grew the real
// header by 2 rows beyond what the JS-computed `availableHeight` assumed,
// so the grid was sized to draw more rows than the space actually left --
// grid content spilled onto the footer row, and an hour-boundary line got
// overdrawn.
//
// FIXED_CLOCK (2026-03-15) is a Sunday; getWeekDays' Monday-start week for
// it is 2026-03-09..2026-03-15, so 2026-03-10 (Tuesday) is safely inside
// the visible week.
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

function threeAllDayEvents() {
  return [
    { id: "ad1", title: "Conference", startTime: "2026-03-10T00:00:00.000Z", endTime: "2026-03-11T00:00:00.000Z", allDay: true },
    { id: "ad2", title: "Offsite", startTime: "2026-03-10T00:00:00.000Z", endTime: "2026-03-11T00:00:00.000Z", allDay: true },
    { id: "ad3", title: "Holiday", startTime: "2026-03-10T00:00:00.000Z", endTime: "2026-03-11T00:00:00.000Z", allDay: true },
  ];
}

function mount(id: string, events: unknown[], size: { columns: number; rows: number }) {
  ids.push(id);
  return renderCanvas(
    <Calendar
      id={id}
      config={{ title: "Team Calendar", events: events as never, startHour: 8, endHour: 18 }}
      enabled={true}
      scenario="display"
    />,
    size
  );
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

test("3 all-day events on one visible day: all 3 render, the frame fits the terminal's row budget, and nothing overdraws the footer", async () => {
  const id = "cal-allday-3";
  const size = { columns: 70, rows: 18 };
  const r = mount(id, threeAllDayEvents(), size);
  const frame = await r.settle();
  await awaitRecord(id, 5000);

  const lines = stripAnsi(frame).split("\n");
  // Ink never emits more terminal rows than the pane actually has.
  expect(lines.length).toBeLessThanOrEqual(size.rows);

  // All 3 all-day events are visible (truncated titles are fine; the row
  // itself isn't dropped or squeezed to fewer than 3 lines).
  expect(frame).toContain("Conferen"); // "Conference" truncated to columnWidth
  expect(frame).toContain("Offsite");
  expect(frame).toContain("Holiday");

  // The footer's key hints render as their OWN clean line -- not visually
  // merged with a stray fragment of the grid's dashed/dotted separator
  // line (the exact "overdrawn" symptom the bug report describes). A
  // footer line ending in a lone separator character right after "q quit"
  // is exactly that symptom.
  const footerLine = lines.find((l) => l.includes("q quit"));
  expect(footerLine).toBeDefined();
  expect(footerLine).toMatch(/q quit\s*$/);

  r.dispose();
});

// The all-day row must reserve at least 1 line even when the ONLY all-day
// event in the whole config falls outside the currently visible week --
// AllDayEventsRow's own "any all-day event exists at all" check is global,
// not scoped to the visible week, so it still renders a (blank) row for
// every visible day. Missing this reproduced the identical footer-overdraw
// symptom with events that were never even shown on screen.
test("an all-day event outside the visible week still reserves the row's height (no overdraw)", async () => {
  const id = "cal-allday-offweek";
  const size = { columns: 70, rows: 18 };
  const events = [
    { id: "ad1", title: "Conference", startTime: "2026-01-05T00:00:00.000Z", endTime: "2026-01-06T00:00:00.000Z", allDay: true },
  ];
  const r = mount(id, events, size);
  const frame = await r.settle();
  await awaitRecord(id, 5000);

  const lines = stripAnsi(frame).split("\n");
  expect(lines.length).toBeLessThanOrEqual(size.rows);

  const footerLine = lines.find((l) => l.includes("q quit"));
  expect(footerLine).toBeDefined();
  expect(footerLine).toMatch(/q quit\s*$/);

  r.dispose();
});

// Baseline: zero all-day events must render exactly as before this fix
// (the historical "5" header budget, unchanged) -- this fix must not
// change behavior for the common case that has no all-day events at all.
test("zero all-day events: unaffected, no change from historical behavior", async () => {
  const id = "cal-allday-zero";
  const size = { columns: 70, rows: 18 };
  const events = [
    { id: "e1", title: "Standup", startTime: "2026-03-10T09:00:00.000Z", endTime: "2026-03-10T09:15:00.000Z" },
  ];
  const r = mount(id, events, size);
  const frame = await r.settle();
  await awaitRecord(id, 5000);

  const lines = stripAnsi(frame).split("\n");
  expect(lines.length).toBeLessThanOrEqual(size.rows);
  expect(frame).toContain("08:00-14:00"); // the historical 12-visible-slot window

  const footerLine = lines.find((l) => l.includes("q quit"));
  expect(footerLine).toBeDefined();
  expect(footerLine).toMatch(/q quit\s*$/);

  r.dispose();
});
