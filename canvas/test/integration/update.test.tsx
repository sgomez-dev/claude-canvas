import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import { Table } from "../../src/canvases/table";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection, pushUpdate } from "../../src/runtime/client";
import { nextOutcome, settleUntil } from "../harness/ipc";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

// `update` existed in the protocol and in useCanvasServer's `onUpdate` from
// Phase 1, but had no caller anywhere: no CLI verb, and none of the Phase 2
// primitives implemented the callback. The roadmap chose TCP over
// files-plus-polling precisely because polling "gives up server-push to the
// canvas -- which live `update` needs", so the capability that decided the
// transport could not be invoked at all.

async function mount(node: React.ReactElement, id: string) {
  ids.push(id);
  const r = renderCanvas(node, { columns: 50, rows: 14 });
  await r.settle();
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  return r;
}

test("a pushed config replaces a picker's options and resets the cursor", async () => {
  const id = "upd-picker";
  const r = await mount(
    <Picker
      id={id}
      config={{ mode: "single", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }}
      enabled={true}
    />,
    id
  );
  expect(await r.settle()).toContain("Alpha");

  // Move the cursor onto the second option, so the reset is observable.
  r.stdin.write("j");
  await r.settle();

  await pushUpdate(id, {
    mode: "single",
    options: [{ id: "x", label: "Gamma" }, { id: "y", label: "Delta" }],
  });
  // Polls rather than asserting after one macrotask: pushUpdate resolves
  // when the bytes reach the socket, not when the canvas has re-rendered.
  const frame = await settleUntil(r, (f) => f.includes("Gamma"));
  expect(frame).toContain("Gamma");
  expect(frame).not.toContain("Alpha");
  // Cursor is back on the first option of the new list, not still on index 1.
  expect(frame).toContain("> Gamma");

  // And selecting now yields an id from the NEW config.
  const conn = await openConnection(id);
  r.stdin.write("\r");
  await r.settle();
  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { selectedIds: ["x"] },
  });
  conn.close();
  r.dispose();
});

test("a pushed config refreshes a table's rows and resets the scroll", async () => {
  const id = "upd-table";
  const rows = Array.from({ length: 30 }, (_, i) => ({ n: String(i + 1) }));
  const r = await mount(
    <Table
      id={id}
      config={{ title: "Live", columns: [{ key: "n", label: "N", width: 6 }], rows }}
      enabled={true}
    />,
    id
  );
  r.stdin.write("\x1b[6~"); // page down, so the reset is observable
  expect(await r.settle()).not.toContain("rows 1-");

  await pushUpdate(id, {
    title: "Live",
    columns: [{ key: "n", label: "N", width: 6 }],
    rows: [{ n: "only" }],
  });
  const frame = await settleUntil(r, (f) => f.includes("only"));
  expect(frame).toContain("only");
  // One row now, so no range counter, and the body is back at the top.
  expect(frame).not.toContain("of 30");
  r.dispose();
});

// The most important reset of the four: decisions are keyed by hunk id, and
// an id from the previous diff can collide with an unrelated hunk in the new
// one -- carrying them over would apply a decision to code the user never
// saw.
test("a pushed diff drops decisions made against the previous one", async () => {
  const id = "upd-diff";
  const first = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-one
+ONE
`;
  const second = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-two
+TWO
`;
  const r = await mount(<Diff id={id} config={{ diffText: first }} enabled={true} />, id);

  r.stdin.write("a"); // approve the only hunk of the first diff
  expect(await r.settle()).toContain("[approved]");

  // Same path, same hunk index, so the same hunk id -- the collision case.
  await pushUpdate(id, { diffText: second });
  const frame = await settleUntil(r, (f) => f.includes("TWO"));
  expect(frame).toContain("TWO");
  expect(frame).toContain("[undecided]");
  expect(frame).not.toContain("[approved]");

  // Submitting now reports the new hunk as rejected, since nothing was
  // decided about it. Silence is not consent for code the user never saw.
  const conn = await openConnection(id);
  r.stdin.write("\r");
  await r.settle();
  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "x.txt#0", decision: "rejected" }] },
  });
  conn.close();
  r.dispose();
});

test("a large config survives the update path instead of being truncated", async () => {
  const id = "upd-big";
  const r = await mount(
    <Table id={id} config={{ columns: [{ key: "v", label: "V" }], rows: [] }} enabled={true} />,
    id
  );
  // 3000 rows is a config well past a single socket write on this platform;
  // pushUpdate waits for the writer to drain before closing, which is what
  // keeps it intact.
  const rows = Array.from({ length: 3000 }, (_, i) => ({ v: `value-${i}-${"x".repeat(200)}` }));
  await pushUpdate(id, { columns: [{ key: "v", label: "V", width: 12 }], rows });
  // ~600 KB has to cross the socket, be reassembled by FrameDecoder and
  // re-render. One macrotask is nowhere near enough on a loaded runner:
  // this assertion after a bare settle() is what turned ubuntu-latest red
  // on a docs-only commit.
  const frame = await settleUntil(r, (f) => f.includes("of 3000"), 15_000);
  expect(frame).toContain("of 3000");
  r.dispose();
});
