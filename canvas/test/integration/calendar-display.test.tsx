import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { calendarDisplayConfig, FIXED_CLOCK } from "../fixtures/configs";
import { awaitRecord, deleteRecord, readRecord } from "../../src/runtime/registry";
import { getValue, openConnection, requestClose } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

// The `display` scenario's own IPC server had zero test coverage: it was
// added in an earlier fix, but nothing exercised the registry record, get,
// close, or (the bug this same wave fixes) what a normal `q` quit reports.
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

function mount(id: string, enabled = true) {
  if (enabled) ids.push(id);
  return renderCanvas(
    <Calendar id={id} config={calendarDisplayConfig} enabled={enabled} scenario="display" />,
    { columns: 70, rows: 18 }
  );
}

test("a registry record is written for the display scenario", async () => {
  const id = "cal-disp-it-1";
  const r = mount(id);
  await r.settle();

  const record = await awaitRecord(id, 5000);
  expect(record).not.toBeNull();
  expect(record?.kind).toBe("calendar");
  expect(record?.scenario).toBe("display");

  r.dispose();
});

test("get answers the config for key 'config'", async () => {
  const id = "cal-disp-it-2";
  const r = mount(id);
  await r.settle();
  await awaitRecord(id, 5000);

  const value = await getValue(id, "config");
  expect(value).toEqual(calendarDisplayConfig);

  // Any other key is unhandled, same as every other canvas's onGet.
  expect(await getValue(id, "nope")).toBeNull();

  r.dispose();
});

test("close removes the registry record", async () => {
  const id = "cal-disp-it-3";
  const r = mount(id);
  await r.settle();
  await awaitRecord(id, 5000);

  await requestClose(id);
  await r.settle();

  const record = await readRecord(id);
  expect(record).toBeNull();

  r.dispose();
});

// THE bug this wave fixes: quitting with 'q' used to call exit() without
// ever recording an outcome, so the unmount cleanup deleted the record
// before a `wait` could see it -- turning a normal, successful view-only
// quit into "no canvas <id>" (an error) instead of "cancelled" (what this
// project's own docs promise for a view-only scenario's normal end of
// life).
//
// The connection is opened BEFORE the quit key is sent (same pattern as
// table.test.tsx's own escape/cancelled test) so the outcome is read live
// off the socket, rather than depending on the disk-persistence path
// succeeding by the time the process has already exited.
test("quitting with 'q' reports a cancelled outcome, not a vanished record", async () => {
  const id = "cal-disp-it-4";
  const r = mount(id);
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  r.stdin.write("q");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "User quit" });

  conn.close();
  r.dispose();
});

test("quitting with Escape also reports a cancelled outcome", async () => {
  const id = "cal-disp-it-5";
  const r = mount(id);
  await r.settle();
  await awaitRecord(id, 5000);
  const conn = await openConnection(id);

  r.stdin.write("\x1b");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "User quit" });

  conn.close();
  r.dispose();
});
