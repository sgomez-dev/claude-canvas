import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const SINGLE_CONFIG = {
  mode: "single" as const,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

const MULTI_CONFIG = {
  mode: "multi" as const,
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ],
};

test("single mode: pressing Enter on the highlighted option selects it", async () => {
  const id = "picker-it-1";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\r"); // Enter, on the first (default-highlighted) option
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["a"] } });
  conn.close();
  r.dispose();
});

test("single mode: moving down then selecting picks the second option", async () => {
  const id = "picker-it-2";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["b"] } });
  conn.close();
  r.dispose();
});

test("multi mode: toggling both options and submitting returns both ids", async () => {
  const id = "picker-it-3";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={MULTI_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write(" "); // toggle x
  await r.settle();
  r.stdin.write("j"); // move to y
  await r.settle();
  r.stdin.write(" "); // toggle y
  await r.settle();
  r.stdin.write("\r"); // submit
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["x", "y"] } });
  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const id = "picker-it-4";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\x1b");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});
