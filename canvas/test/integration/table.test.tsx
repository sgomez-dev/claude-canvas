import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Table } from "../../src/canvases/table";
import type { TableConfig } from "../../src/canvases/table/types";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection, getValue } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

// 30 rows in a 12-row terminal. The component reserves 6 rows for chrome,
// so exactly 6 data rows are visible and the body has somewhere to scroll.
const CONFIG: TableConfig = {
  title: "Thirty rows",
  columns: [
    { key: "n", label: "N", width: 4 },
    { key: "name", label: "Name", width: 10 },
  ],
  rows: Array.from({ length: 30 }, (_, i) => ({ n: String(i + 1), name: `row-${i + 1}` })),
};

function mount(id: string, enabled = false) {
  if (enabled) ids.push(id);
  return renderCanvas(<Table id={id} config={CONFIG} enabled={enabled} />, {
    columns: 40,
    rows: 12,
  });
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PGDN = "\x1b[6~";
const PGUP = "\x1b[5~";
const ESC = "\x1b";

// The footer's "rows X-Y of Z" counter is asserted instead of row labels
// because "row-1" is a substring of "row-10" -- a containment check on the
// labels would pass for the wrong window.
test("the body scrolls one row at a time while the header stays put", async () => {
  const r = mount("table-scroll-1");
  let frame = await r.settle();
  expect(frame).toContain("rows 1-6 of 30");
  expect(frame).toContain("Name");

  for (let i = 0; i < 3; i++) {
    r.stdin.write(DOWN);
    frame = await r.settle();
  }
  expect(frame).toContain("rows 4-9 of 30");
  // The header renders outside the scrolled slice, so it must survive every
  // scroll -- the spec's "a fixed header row stays visible while the body
  // scrolls".
  expect(frame).toContain("Name");
  r.dispose();
});

test("PageDown moves a whole window and PageUp comes back", async () => {
  const r = mount("table-scroll-2");
  await r.settle();

  r.stdin.write(PGDN);
  expect(await r.settle()).toContain("rows 7-12 of 30");
  r.stdin.write(PGDN);
  expect(await r.settle()).toContain("rows 13-18 of 30");
  r.stdin.write(PGUP);
  expect(await r.settle()).toContain("rows 7-12 of 30");

  r.dispose();
});

test("scrolling clamps at both ends instead of running past the data", async () => {
  const r = mount("table-scroll-3");
  await r.settle();

  r.stdin.write(UP); // already at the top
  expect(await r.settle()).toContain("rows 1-6 of 30");

  let frame = "";
  for (let i = 0; i < 12; i++) {
    r.stdin.write(PGDN);
    frame = await r.settle();
  }
  expect(frame).toContain("rows 25-30 of 30");

  r.dispose();
});

test("j and k scroll as well, matching picker and diff", async () => {
  const r = mount("table-scroll-4");
  await r.settle();

  r.stdin.write("j");
  expect(await r.settle()).toContain("rows 2-7 of 30");
  r.stdin.write("k");
  expect(await r.settle()).toContain("rows 1-6 of 30");

  r.dispose();
});

// `table` is view-only: the spec states there is no "selected" outcome and
// that "closing always sends sendCancelled". This is the whole IPC contract
// for this primitive, over a real socket.
test("escape reports cancelled over a real socket, never selected", async () => {
  const id = "table-it-1";
  const r = mount(id, true);
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write(ESC);
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "escape" });
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();
  r.dispose();
});

test("a second escape does not send a second outcome", async () => {
  const id = "table-it-2";
  const r = mount(id, true);
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write(ESC);
  await r.settle();
  r.stdin.write(ESC);
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "escape" });
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();
  r.dispose();
});

// Documents the current shape rather than asserting an aspiration: `table`
// implements no onGet, so `get <id> <key>` answers null for every key, the
// same as flight and calendar. Only `document` answers keys today.
test("get answers null for any key, since table exposes no readable state", async () => {
  const id = "table-it-3";
  const r = mount(id, true);
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  expect(await getValue(id, "rows")).toBeNull();

  r.dispose();
});
