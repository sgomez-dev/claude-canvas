import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Form } from "../../src/canvases/form";
import type { FormConfig } from "../../src/canvases/form/types";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

// Focus order is fields[0..4] then the Submit button at index 5.
const CONFIG: FormConfig = {
  fields: [
    { id: "name", type: "text", label: "Name", required: true },
    { id: "notes", type: "textarea", label: "Notes" },
    {
      id: "level",
      type: "select",
      label: "Level",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    { id: "urgent", type: "checkbox", label: "Urgent" },
    { id: "count", type: "number", label: "Count", min: 1, max: 10 },
  ],
};

const COUNT_ONLY: FormConfig = {
  fields: [{ id: "count", type: "number", label: "Count", min: 1, max: 10 }],
};

// No `min`, so the component accepts a leading "-" -- which is the entry
// point for the NaN defect the last test below pins.
const DELTA_ONLY: FormConfig = {
  fields: [{ id: "delta", type: "number", label: "Delta", required: true }],
};

async function mount(id: string, config: FormConfig) {
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={config} enabled={true} />, {
    columns: 60,
    rows: 22,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));
  return r;
}

async function type(r: Awaited<ReturnType<typeof mount>>, keys: string[]) {
  for (const k of keys) {
    r.stdin.write(k);
    await r.settle();
  }
}

const TAB = "\t";
const ENTER = "\r";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

test("a completed form submits one value per field, correctly typed", async () => {
  const r = await mount("form-it-1", CONFIG);
  const conn = await openConnection("form-it-1");

  await type(r, ["A", "d", "a"]);          // name
  await type(r, [TAB, "h", "i"]);          // notes
  await type(r, [TAB, RIGHT]);             // level: a -> b
  await type(r, [TAB, " "]);               // urgent: false -> true
  await type(r, [TAB, "7"]);               // count
  await type(r, [TAB, ENTER]);             // Submit

  const msg = await nextOutcome(conn, 2000);
  // checkbox -> boolean, number -> number, everything else -> string, per
  // the spec's per-type result requirement.
  expect(msg).toEqual({
    type: "selected",
    data: { values: { name: "Ada", notes: "hi", level: "b", urgent: true, count: 7 } },
  });
  conn.close();
  r.dispose();
});

// The spec's hard rule: "a form primitive that can silently submit
// incomplete required data is worse than one that refuses to."
test("submitting with a required field empty keeps the form open and sends nothing", async () => {
  const r = await mount("form-it-2", CONFIG);
  const conn = await openConnection("form-it-2");

  // Straight to Submit with `name` still empty.
  await type(r, [TAB, TAB, TAB, TAB, TAB, ENTER]);

  expect(await nextOutcome(conn, 300)).toBeNull();
  const frame = await r.settle();
  expect(frame).toContain("<- required");
  conn.close();
  r.dispose();
});

// The spec is explicit that a number field clamps "when the field loses
// focus, not on every keystroke (so a user can type '1' on the way to '12'
// without it being clamped mid-entry)".
test("a number field clamps on blur, not mid-keystroke", async () => {
  const r = await mount("form-it-3", COUNT_ONLY);

  await type(r, ["9", "9"]);
  expect(await r.settle()).toContain("99"); // still focused: not clamped yet

  await type(r, [TAB]); // blur -> clamp to max
  expect(await r.settle()).toContain("10");

  r.dispose();
});

// Regression test. A lone "-" (typed on the way to "-5") used to survive
// clampNumber untouched, reach Number() at submit time as NaN, and travel to
// the controller as `null` -- for a REQUIRED field, which is exactly the
// silent-incomplete-submit the spec forbids.
test("a required number holding only a minus sign never submits as null", async () => {
  const r = await mount("form-it-4", DELTA_ONLY);
  const conn = await openConnection("form-it-4");

  await type(r, ["-"]);
  await type(r, [TAB, ENTER]); // blur clears the unparseable entry, then submit

  expect(await nextOutcome(conn, 300)).toBeNull();
  expect(await r.settle()).toContain("<- required");
  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const r = await mount("form-it-5", CONFIG);
  const conn = await openConnection("form-it-5");

  await type(r, [ESC]);

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});

// form.tsx shipped without the submittedRef guard that picker.tsx and
// diff.tsx both have, so submitting and then pressing Escape sent BOTH
// `selected` and `cancelled` and the controller acted on whichever it read
// first.
test("Enter then Escape in quick succession only sends one outcome message", async () => {
  const r = await mount("form-it-6", COUNT_ONLY);
  const conn = await openConnection("form-it-6");

  await type(r, ["5", TAB, ENTER]);
  r.stdin.write(ESC);
  await r.settle();

  const first = await nextOutcome(conn, 2000);
  expect(first).toEqual({ type: "selected", data: { values: { count: 5 } } });
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();
  r.dispose();
});

// NOTE on what is deliberately NOT tested here: the `sendError` path for a
// config error (e.g. a select with no options) is not observable from a
// controller in this flow, and neither picker.tsx's nor diff.tsx's
// integration tests cover theirs either. Those components gate the send on
// `ipc.isConnected`, which reports that the canvas's own SERVER came up --
// not that a controller has attached to it. A controller can only learn the
// port by reading the registry record, which the server writes as it
// starts, so by the time `wait` connects the error has already been
// broadcast to zero connections and dropped. The config error is still
// rendered in the pane (covered by test/snapshots/form.test.tsx), so a
// human sees it; Claude does not. Fixing that needs the outcome to outlive
// the broadcast -- see the Phase 2 ledger's "known gap" entry.
