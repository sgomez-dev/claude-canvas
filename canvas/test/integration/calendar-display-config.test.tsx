import { test, expect, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { openConnection } from "../../src/runtime/client";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { nextOutcome } from "../harness/ipc";
import { FIXED_CLOCK } from "../fixtures/configs";

// The `display` scenario's `meetingPickerConfigError`-sibling gap: unlike
// meeting-picker (which validates startHour/endHour via
// meetingPickerConfigError), display read `config?.startHour ?? START_HOUR`
// and `config?.endHour ?? END_HOUR` with NO validation at all. An inverted,
// equal, negative, or fractional pair silently produced a broken/empty grid
// (zero or negative totalSlots, garbled hour labels) with no error ever
// reported to the controller. Mirrors meeting-picker-config.test.tsx's own
// tests for the identical bug in the sibling scenario.
const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

function mount(id: string, config: unknown) {
  ids.push(id);
  const restore = stubRealStdout();
  const r = renderCanvas(
    <Calendar id={id} config={config as never} enabled={true} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  return { r, restore };
}

async function expectRejected(config: unknown, messageSubstring: string) {
  const id = `cdc-${Math.random().toString(36).slice(2)}`;
  const { r, restore } = mount(id, config);
  await r.settle();
  // The record's write races the render on a busy machine (see the
  // registry.ts doc comments on rename contention under load); asserting
  // here turns a genuinely slow-but-eventually-successful write into a
  // clear "the record never appeared" failure instead of the confusing
  // "no canvas <id>" connection error openConnection throws when called
  // against an id with no record at all.
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  const conn = await openConnection(id);

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("error");
  expect((msg as { message: string }).message).toContain(messageSubstring);

  conn.close();
  r.dispose();
  restore();
}

test("an inverted startHour/endHour pair is rejected as a config error", async () => {
  await expectRejected({ startHour: 22, endHour: 6 }, "startHour");
});

test("a negative startHour is rejected as a config error", async () => {
  await expectRejected({ startHour: -5, endHour: 4 }, "startHour");
});

test("an equal startHour/endHour pair is rejected as a config error", async () => {
  await expectRejected({ startHour: 9, endHour: 9 }, "startHour");
});

test("a fractional startHour is rejected as a config error", async () => {
  await expectRejected({ startHour: 6.5, endHour: 12 }, "startHour");
});

test("a fractional endHour is rejected as a config error", async () => {
  await expectRejected({ startHour: 9, endHour: 12.5 }, "endHour");
});

// A partial override (only startHour given) is checked against the OTHER
// field's real EFFECTIVE value (the default endHour, 22), not skipped just
// because endHour wasn't explicitly provided.
test("a partial override checked against the other field's default is still rejected when inverted", async () => {
  await expectRejected({ startHour: 23 }, "startHour");
});

// A normal valid range must still render correctly -- no regression.
test("a normal valid startHour/endHour range like {9, 17} still renders", async () => {
  const id = "cdc-valid";
  const { r, restore } = mount(id, { startHour: 9, endHour: 17 });
  const frame = await r.settle();
  expect(frame).not.toContain("calendar config");
  expect(frame).toContain("9am");

  r.dispose();
  restore();
});

// The gap this closes: every OTHER fixture in this suite sets
// startHour/endHour explicitly, so a change to the ACTUAL defaults (SKILL.md
// promises 6am-22:00) would silently pass the whole existing test suite --
// nothing exercises what a caller who omits both fields actually gets. `{}`
// (no startHour, no endHour at all, not even `undefined` values for them)
// is display.tsx's real "caller declared no hours" case.
test("with no startHour/endHour override, the documented 6am-10pm default range renders", async () => {
  // Pinned: the "now" indicator line overwrites whichever hour label it
  // falls on (see display-view.tsx's nowLinePosition), so an unpinned real
  // clock landing on 6:xx am would overwrite the very label this test
  // checks for -- flaky in exactly the way that let the underlying default
  // go uncovered.
  setSystemTime(FIXED_CLOCK);
  try {
    const id = "cdc-defaults";
    const { r, restore } = mount(id, {});
    const frame = await r.settle();
    expect(frame).not.toContain("calendar config");
    // The first visible hour label is the default startHour (6), formatted
    // 12-hour: formatHour(6) -> "6", getAmPm(6) -> "am".
    expect(frame).toContain("6am");
    // At 70x18 the historical no-all-day-events header/footer budget leaves
    // a 12-slot (6-hour) visible window; from a 6am default start that is
    // "06:00-12:00" -- pinning the actual DEFAULT_START_HOUR value, not
    // just that some hour label rendered.
    expect(frame).toContain("06:00-12:00");

    r.dispose();
    restore();
  } finally {
    setSystemTime();
  }
});
