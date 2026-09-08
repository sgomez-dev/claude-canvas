import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import type { PickerResult } from "../../src/canvases/picker/types";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

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

const DISABLED_CONFIG = {
  mode: "single" as const,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B", disabled: true },
    { id: "c", label: "C" },
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

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["a"] } });
  conn.close();
  r.dispose();
});

// The single settle() between "j" and Enter here is deliberate and
// load-bearing, not incidental test timing: useInput's handler is
// re-registered in a passive effect that lags one render behind a
// state-driven re-render (same bug class as diff.tsx's cursorRef/decisions
// stale-closure bug), so this pins that a move immediately followed by a
// select reads the just-committed cursor, not a stale one.
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

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["b"] } });
  conn.close();
  r.dispose();
});

// As above: each keystroke here is separated by exactly one settle() on
// purpose, to pin that rapid toggle-then-move-then-toggle-then-submit
// sequences read the current `checked`/`cursor` state rather than a stale
// closure captured by a not-yet-resubscribed useInput handler.
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

  const msg = await nextOutcome(conn, 2000);
  // Multi-select result ordering is intentionally unspecified, so this
  // asserts membership (as a Set), not array order.
  expect(msg?.type).toBe("selected");
  const data = msg && msg.type === "selected" ? (msg.data as PickerResult) : undefined;
  expect(new Set(data?.selectedIds)).toEqual(new Set(["x", "y"]));
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

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});

// Regression: without a submittedRef guard, Enter-then-Enter in quick
// succession (before unmount actually completes) could fire sendSelected
// twice.
test("Enter twice in quick succession only sends one outcome message", async () => {
  const id = "picker-it-5";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\r");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["a"] } });
  // No second message should follow.
  const second = await nextOutcome(conn, 300);
  expect(second).toBeNull();

  conn.close();
  r.dispose();
});

// Behavioral regression for the disabled-option-skip logic (previously
// pinned only by a static render snapshot, not by an actual keypress):
// moving the cursor past a disabled option must land on the next enabled
// one, not stop on the disabled row.
test("navigating with a disabled option in the middle skips over it", async () => {
  const id = "picker-it-6";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={DISABLED_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("j"); // from A, should skip disabled B and land on C
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["c"] } });
  conn.close();
  r.dispose();
});

// A list longer than the pane used to render every option, overflowing the
// terminal. 25 options in a 12-row terminal leaves room for 7 at a time.
const LONG_CONFIG = {
  mode: "single" as const,
  options: Array.from({ length: 25 }, (_, i) => ({
    id: `opt-${i + 1}`,
    label: `Option ${i + 1}`,
  })),
};

test("a list longer than the pane shows one window at a time", async () => {
  const id = "picker-it-long-1";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={LONG_CONFIG} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  let frame = await r.settle();
  expect(frame).toContain("1-7 of 25");

  // Seven moves puts the cursor on index 7, the first option of the next
  // window, so the window advances.
  for (let i = 0; i < 7; i++) {
    r.stdin.write("j");
    frame = await r.settle();
  }
  expect(frame).toContain("8-14 of 25");
  r.dispose();
});

// Guards the index arithmetic the window introduces: the id sent must be
// the cursor's option, not the one at the same position within the window.
test("selecting from a later window returns that option's id, not the window offset's", async () => {
  const id = "picker-it-long-2";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={LONG_CONFIG} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  for (let i = 0; i < 9; i++) {
    r.stdin.write("j");
    await r.settle();
  }
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "selected", data: { selectedIds: ["opt-10"] } });
  conn.close();
  r.dispose();
});
