import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { openConnection } from "../../src/runtime/client";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { nextOutcome } from "../harness/ipc";

// isMeetingPickerConfig's own error message, and the calendar skill doc,
// both already promised an empty `calendars` array is a config error --
// but nothing enforced it at runtime until this fix. Likewise nothing
// enforced `slotGranularity` being one of the values the grid actually
// supports (15/30/60), so a bad value like 7 reached the slot-count math
// and produced fractional loop bounds.
const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

function mount(id: string, config: unknown) {
  ids.push(id);
  const restore = stubRealStdout();
  const r = renderCanvas(
    <Calendar id={id} config={config as never} enabled={true} scenario="meeting-picker" />,
    { columns: 70, rows: 18 }
  );
  return { r, restore };
}

test("an empty calendars array is rejected as a config error", async () => {
  const id = "mpc-empty-calendars";
  const { r, restore } = mount(id, { calendars: [] });
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("error");
  expect((msg as { message: string }).message).toContain("non-empty 'calendars'");

  conn.close();
  r.dispose();
  restore();
});

test("a missing calendars field is rejected as a config error", async () => {
  const id = "mpc-missing-calendars";
  const { r, restore } = mount(id, {});
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("error");
  expect((msg as { message: string }).message).toContain("non-empty 'calendars'");

  conn.close();
  r.dispose();
  restore();
});

test("a slotGranularity outside 15/30/60 is rejected as a config error", async () => {
  const id = "mpc-bad-granularity";
  const { r, restore } = mount(id, {
    calendars: [{ name: "Ana", color: "cyan", events: [] }],
    slotGranularity: 7,
  });
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("error");
  expect((msg as { message: string }).message).toContain("slotGranularity");

  conn.close();
  r.dispose();
  restore();
});

test("a valid slotGranularity of 15 is accepted", async () => {
  const id = "mpc-good-granularity";
  const { r, restore } = mount(id, {
    calendars: [{ name: "Ana", color: "cyan", events: [] }],
    slotGranularity: 15,
  });
  const frame = await r.settle();
  // No error rendered; the picker's own title bar shows instead.
  expect(frame).toContain("Select a meeting time");

  r.dispose();
  restore();
});

// Fix 4(c): BaseCalendarConfig's startHour/endHour used to be declared in
// the config type but ignored at runtime -- calendar.tsx hardcoded 6/22
// regardless of what a caller declared. Confirm a caller's declared hours
// are genuinely forwarded into the meeting picker's own grid.
test("a declared startHour/endHour is forwarded into the meeting picker grid", async () => {
  const id = "mpc-custom-hours";
  const { r, restore } = mount(id, {
    calendars: [{ name: "Ana", color: "cyan", events: [] }],
    slotGranularity: 60,
    startHour: 9,
    endHour: 12,
  });
  const frame = await r.settle();
  // 9:00-12:00 at 60-minute granularity is 3 slots, comfortably inside the
  // 18-row pane, so no window label appears and the grid starts at 9am.
  expect(frame).toContain("9am");
  expect(frame).not.toContain("6am");
  expect(frame).not.toContain("10pm");

  r.dispose();
  restore();
});
