import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const ONE_HUNK_DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-old
+new
`;

test("approving the only hunk and submitting sends the right result over a real socket", async () => {
  const id = "diff-it-1";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  // Wait for the server to start and the registry record to be written.
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // Simulate the user: approve the hunk, then press Enter to submit.
  r.stdin.write("a");
  await r.settle();
  // A second tick: the harness's settle() surfaces the committed render (the
  // frame already shows "[approved]" after one tick), but useInput's own
  // effect re-subscribes its listener with the *new* decisions closure as a
  // passive effect, which flushes on the tick after that. Sending "\r" right
  // after only one settle() races that resubscription and it gets processed
  // by the stale (pre-approval) handler — reproduced deterministically
  // in this environment. One extra settle() lets that resubscription land
  // before the next simulated keypress.
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "approved" }] },
  });

  conn.close();
  r.dispose();
});

test("submitting without deciding a hunk reports it as rejected", async () => {
  const id = "diff-it-2";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\r"); // submit immediately, no decision made
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "rejected" }] },
  });

  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const id = "diff-it-3";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\x1b"); // Esc
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });

  conn.close();
  r.dispose();
});
