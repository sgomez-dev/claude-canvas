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

// Fix 4: startHour/endHour were wired to actually be respected (the test
// above) but shipped with no validation at all. A negative startHour makes
// `setHours(-5, ...)` silently roll back to the previous day; an inverted
// or equal pair produces zero/negative total slots (nothing selectable,
// no error); fractional values produce fractional loop bounds internally.
// Each must now be rejected as a config error, the same way an out-of-range
// slotGranularity already is.
async function expectRejected(config: unknown, messageSubstring: string) {
  const id = `mpc-hours-${Math.random().toString(36).slice(2)}`;
  const { r, restore } = mount(id, config);
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("error");
  expect((msg as { message: string }).message).toContain(messageSubstring);

  conn.close();
  r.dispose();
  restore();
}

test("a negative startHour is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: -1, endHour: 12 },
    "startHour"
  );
});

test("a fractional startHour is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 9.5, endHour: 12 },
    "startHour"
  );
});

test("a fractional endHour is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 9, endHour: 12.5 },
    "endHour"
  );
});

test("an endHour of 25 (out of range) is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 9, endHour: 25 },
    "endHour"
  );
});

test("an inverted startHour/endHour pair is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 14, endHour: 9 },
    "startHour"
  );
});

test("an equal startHour/endHour pair is rejected as a config error", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 9, endHour: 9 },
    "startHour"
  );
});

// A partial override (only startHour given) is checked against the OTHER
// field's real EFFECTIVE value (the default endHour, 22), not skipped just
// because endHour wasn't explicitly provided. startHour: 23 alone is
// invalid because 23 is not strictly less than the default endHour of 22.
test("a partial override checked against the other field's default is still rejected when inverted", async () => {
  await expectRejected(
    { calendars: [{ name: "Ana", color: "cyan", events: [] }], startHour: 23 },
    "startHour"
  );
});

// A normal valid range still works correctly -- this fix must not reject
// anything that was previously fine.
test("a normal valid startHour/endHour range like {9, 17} still works", async () => {
  const id = "mpc-hours-valid";
  const { r, restore } = mount(id, {
    calendars: [{ name: "Ana", color: "cyan", events: [] }],
    startHour: 9,
    endHour: 17,
  });
  const frame = await r.settle();
  expect(frame).toContain("Select a meeting time");
  expect(frame).toContain("9am");

  r.dispose();
  restore();
});

// endHour: 24 (midnight, end of day) is a legitimate value -- exclusive
// upper bound, so 24 is never itself a bookable slot -- and must be
// accepted, not rejected as "out of range".
test("endHour: 24 (midnight, end of day) is accepted", async () => {
  const id = "mpc-hours-midnight";
  const { r, restore } = mount(id, {
    calendars: [{ name: "Ana", color: "cyan", events: [] }],
    startHour: 20,
    endHour: 24,
  });
  const frame = await r.settle();
  expect(frame).toContain("Select a meeting time");

  r.dispose();
  restore();
});
