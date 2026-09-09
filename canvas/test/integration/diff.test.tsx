import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

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

  const msg = await nextOutcome(conn, 2000);
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

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "rejected" }] },
  });

  conn.close();
  r.dispose();
});

// Regression test for a stale-closure race: useInput's handler is
// re-registered in a passive effect that lags one render behind a
// state-driven re-render. Submitting right after a single settle() tick
// following the approve keystroke — with NO extra tick, unlike the test
// above — used to read `decisions` from the pre-approval closure and report
// "rejected" even though the user approved. Fails against the pre-fix
// `diff.tsx` (which read the closed-over `decisions` directly) and passes
// once the submit branch reads from a ref that's always current.
test("approving and submitting with only a single settle() tick still reports approved", async () => {
  const id = "diff-it-4";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // Simulate a fast, programmatic caller: approve, then submit after only
  // one settle() tick — no second tick to let useInput's resubscription
  // catch up.
  r.stdin.write("a");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "approved" }] },
  });

  conn.close();
  r.dispose();
});

const TWO_HUNK_TWO_FILE_DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-old a
+new a
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-old b
+new b
`;

// Regression test for the CRITICAL stale-closure bug: the "a"/"r" branches
// of useInput read `cursor` (a plain closed-over value) instead of a ref.
// useInput's handler is re-registered in a passive effect that lags one
// render behind a state-driven re-render, so a "j" (move cursor) followed
// by "a" (approve) with only a single settle() tick in between used to have
// the approve land on the PREVIOUS hunk, not the one now highlighted on
// screen. Fails against the pre-fix diff.tsx (approve lands on hunk 1
// instead of hunk 2); passes once the "a"/"r" branches read from a ref that
// is always current.
test("moving the cursor then approving with only a single settle() tick approves the NEW hunk, not the old one", async () => {
  const id = "diff-it-5";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: TWO_HUNK_TWO_FILE_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // Move to hunk 2, then approve it — both with only a single settle() tick
  // each, racing useInput's passive-effect resubscription.
  r.stdin.write("j");
  await r.settle();
  r.stdin.write("a");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: {
      decisions: [
        { hunkId: "a.txt#0", decision: "rejected" },
        { hunkId: "b.txt#0", decision: "approved" },
      ],
    },
  });

  conn.close();
  r.dispose();
});

// CRITICAL regression test for the deeper stale-ref bug: the ref-mirror
// pattern above (`cursorRef.current = cursor` written in the render body)
// is only updated when a render actually commits. Two keystrokes with
// TRULY ZERO delay between them -- back-to-back synchronous write() calls,
// no settle(), no await, not even a microtask -- can both reach useInput's
// handler before React has committed the render that the mirror depends
// on, so the ref stays stale for the SECOND keystroke too. A `setTimeout(0)`
// between keystrokes (as in the test above, and in every pre-existing test
// in this file) is NOT a tight enough proof of this fix: that macrotask is
// exactly what the ref-mirror-in-render-body pattern already survives. This
// only proves the direct-write-in-the-handler fix (cursorRef.current
// written synchronously at the same moment setCursor is called).
test("moving the cursor then approving with truly zero delay between keystrokes approves the NEW hunk, not the old one", async () => {
  const id = "diff-it-zero-delay-1";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: TWO_HUNK_TWO_FILE_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // No settle(), no await, nothing at all between these two writes.
  r.stdin.write("j");
  r.stdin.write("a");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: {
      decisions: [
        { hunkId: "a.txt#0", decision: "rejected" },
        { hunkId: "b.txt#0", decision: "approved" },
      ],
    },
  });

  conn.close();
  r.dispose();
});

// Same zero-delay proof, for decisionsRef: approve immediately followed by
// submit, with nothing between the two writes at all.
test("approving and submitting with truly zero delay between keystrokes still reports approved", async () => {
  const id = "diff-it-zero-delay-2";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("a");
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "approved" }] },
  });

  conn.close();
  r.dispose();
});

const THREE_HUNK_TWO_FILE_DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old a1
+new a1
 shared
@@ -8,2 +8,2 @@
 shared2
-old a2
+new a2
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-old b
+new b
`;

// Broader interaction coverage beyond the single-hunk fixtures every other
// test in this primitive uses: a two-file, multi-hunk diff (3 hunks total),
// navigating across the file boundary, with a genuine mix of all three
// decision states (approved, rejected, undecided-defaults-to-rejected).
test("navigating across a file boundary and mixing approve/reject/undecided submits the exact decisions made", async () => {
  const id = "diff-it-9";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: THREE_HUNK_TWO_FILE_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // Cursor starts at a.txt#0: approve it.
  r.stdin.write("a");
  await r.settle();
  await r.settle();
  // Move to a.txt#1 (still within a.txt): reject it.
  r.stdin.write("j");
  await r.settle();
  await r.settle();
  r.stdin.write("r");
  await r.settle();
  await r.settle();
  // Move to b.txt#0 -- crosses the file boundary. Leave it undecided.
  r.stdin.write("j");
  await r.settle();
  await r.settle();
  // Submit.
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: {
      decisions: [
        { hunkId: "a.txt#0", decision: "approved" },
        { hunkId: "a.txt#1", decision: "rejected" },
        { hunkId: "b.txt#0", decision: "rejected" },
      ],
    },
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

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });

  conn.close();
  r.dispose();
});

// Regression: Escape previously did nothing in the parse-error state — the
// useInput handler's very first line was `if (files.length === 0) return;`,
// so key.escape was never reached once parsing failed, making the pane
// un-exitable by keyboard.
//
// This test previously asserted that Escape produced `cancelled`, and
// carried a note explaining that the sendError-on-parse-failure half of the
// fix could not be asserted over the socket at all: it fired as soon as the
// IPC server came up, which always beat the test's own openConnection().
// Retained outcomes changed that. The parse error is now replayed to a
// controller as it authenticates, so the assertion the note said was
// impossible is the one this test makes.
//
// It also pins the resulting semantics, which are deliberate: the parse
// error is the FIRST outcome, and first outcome wins, so the later Escape
// does not overwrite it with `cancelled`. That is the more useful of the
// two -- Claude learns the diff was unparseable instead of learning only
// that the pane closed.
test("a parse failure is reported to the controller, and Escape still exits", async () => {
  const id = "diff-it-6";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: "not a diff" }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  // Connecting AFTER the error was produced is the whole point.
  const conn = await openConnection(id);
  const outcome = await nextOutcome(conn, 2000);
  expect((outcome as { type: string }).type).toBe("error");
  expect((outcome as { message: string }).message).toContain("Could not determine file path");

  r.stdin.write("\x1b"); // Esc must still work in the error state
  await r.settle();

  // No second, contradicting outcome.
  expect(await nextOutcome(conn, 300)).toBeNull();

  // And Escape really did exit: exit() unmounts Ink, which runs the hook's
  // cleanup, which stops the server -- so the connection dies. That is the
  // observable proof that the pane is not un-exitable, which is the
  // regression this test was written for.
  for (let i = 0; i < 20 && (await conn.next(100)) !== null; i++) {
    /* drain until the peer goes away */
  }
  expect(await conn.next(100)).toBeNull();

  conn.close();
  r.dispose();
});

// Regression: Escape previously did nothing in the empty-diff state either,
// for the same reason (files.length === 0 gated the whole useInput handler
// before key.escape was checked).
test("Escape cancels from the empty-diff state", async () => {
  const id = "diff-it-7";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: "" }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\x1b");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });

  conn.close();
  r.dispose();
});

// Regression: without a submittedRef guard, Enter-then-Enter in quick
// succession (before unmount actually completes) could fire sendSelected
// twice.
test("Enter twice in quick succession only sends one outcome message", async () => {
  const id = "diff-it-8";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\r");
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "rejected" }] },
  });
  // No second message should follow.
  const second = await nextOutcome(conn, 300);
  expect(second).toBeNull();

  conn.close();
  r.dispose();
});

// A binary-only diff has no hunks to approve. Escape would report
// `cancelled`, which is indistinguishable from the user bailing out; an
// empty decision list says "reviewed, nothing to apply".
test("Enter on a binary-only diff submits an empty decision list", async () => {
  const id = "diff-it-binary";
  ids.push(id);
  const diffText = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
  const r = renderCanvas(<Diff id={id} config={{ diffText }} enabled={true} />, {
    columns: 80,
    rows: 16,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "selected", data: { decisions: [] } });
  conn.close();
  r.dispose();
});
