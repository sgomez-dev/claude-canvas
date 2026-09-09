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

// Optional (no `required`), with a `min` an untouched blank field must never
// silently violate.
const OPTIONAL_MIN_FIVE: FormConfig = {
  fields: [{ id: "n", type: "number", label: "N", min: 5, max: 10 }],
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

// CRITICAL regression test for the deeper stale-ref bug: the ref-mirror
// pattern (`focusIndexRef.current = focusIndex` written in the render body)
// is only updated when a render actually commits. Two keystrokes with TRULY
// ZERO delay between them -- back-to-back synchronous write() calls, no
// settle(), no await, not even a microtask -- can both reach useInput's
// handler before React has committed the render the mirror depends on, so
// the ref stays stale for the SECOND keystroke too: Tab (move onto Submit)
// immediately followed by Enter used to have the `onSubmitButton` check
// read the ref's stale pre-move value and silently swallow the submit --
// the form just looked hung, reporting "pending" forever. Every
// pre-existing test in this file separates keystrokes with a settle() tick
// (a `setTimeout(0)` macrotask), which is NOT a tight enough proof: that is
// exactly what the ref-mirror-in-render-body pattern already survives. This
// only proves the direct-write-in-the-handler fix.
test("tabbing onto Submit then pressing Enter with truly zero delay between keystrokes still submits", async () => {
  const r = await mount("form-it-zero-delay-1", COUNT_ONLY);
  const conn = await openConnection("form-it-zero-delay-1");

  await type(r, ["5"]); // type a value, settled
  // No settle(), no await, nothing at all between these two writes: Tab
  // onto the Submit button, then Enter.
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { count: 5 } } });
  conn.close();
  r.dispose();
});

// Regression test for Fix 4: `Number("")` evaluates to 0 in JavaScript, so
// an optional number field with a declared `min` left completely untouched
// used to silently submit 0 on the wire -- violating the field's own
// constraint (min: 5 must never produce {"n": 0}). Tab straight past the
// field to Submit without ever touching it, so `values.n` stays at its
// never-typed initial "".
test("an optional number field with min:5 left untouched does not submit a value that violates its own min", async () => {
  const r = await mount("form-it-optional-min", OPTIONAL_MIN_FIVE);
  const conn = await openConnection("form-it-optional-min");

  await type(r, [TAB, ENTER]); // straight to Submit, field never touched

  const msg = await nextOutcome(conn, 2000);
  expect(msg?.type).toBe("selected");
  const values =
    msg && msg.type === "selected" ? (msg.data as { values: Record<string, unknown> }).values : {};
  // Must not be the violating 0. The field is optional, so omitting it
  // entirely is an equally acceptable outcome to submitting nothing that
  // violates `min` -- either way, `n` must never be 0.
  expect(values.n).not.toBe(0);
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

// --------------------------------------------------------------------------
// Regression tests for the incomplete Fix 1 patch: `valuesRef` was declared
// as a render-body-only mirror of `values` state (identical in SHAPE to the
// zero-delay-safe `focusIndexRef` pattern above), but none of the setValues
// call sites in the useInput handler also wrote `valuesRef.current` directly
// -- so the mirror only ever caught up on the NEXT render, typically 2-4ms
// later. A burst with truly zero delay between keystrokes (no settle(), no
// await, not even a microtask, between any of the writes below) reaches
// attemptSubmit before that render commits, so attemptSubmit (and
// isMissing) read a STALE valuesRef.current -- the field's pre-edit value,
// not what was actually just entered. Every scenario below is exactly the
// kind of burst the pre-existing tests above never exercised: they all
// separate the value-changing keystroke from Tab/Enter with a settle().
// --------------------------------------------------------------------------

const BURST_TEXT: FormConfig = {
  fields: [{ id: "name", type: "text", label: "Name" }],
};
const BURST_TEXT_REQUIRED: FormConfig = {
  fields: [{ id: "name", type: "text", label: "Name", required: true }],
};
const BURST_TEXTAREA: FormConfig = {
  fields: [{ id: "notes", type: "textarea", label: "Notes" }],
};
const BURST_NUMBER_OPTIONAL: FormConfig = {
  fields: [{ id: "count", type: "number", label: "Count", min: 1, max: 10 }],
};
const BURST_NUMBER_REQUIRED: FormConfig = {
  fields: [{ id: "count", type: "number", label: "Count", required: true }],
};
const BURST_CHECKBOX: FormConfig = {
  fields: [{ id: "urgent", type: "checkbox", label: "Urgent" }],
};
const BURST_SELECT: FormConfig = {
  fields: [
    {
      id: "level",
      type: "select",
      label: "Level",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
};
const BURST_COMPOUND: FormConfig = {
  fields: [
    { id: "urgent", type: "checkbox", label: "Urgent" },
    {
      id: "level",
      type: "select",
      label: "Level",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
};

test("burst (text): type, Tab, Enter with zero delay submits the typed character, not the default empty string", async () => {
  const r = await mount("form-it-burst-text", BURST_TEXT);
  const conn = await openConnection("form-it-burst-text");

  r.stdin.write("A");
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { name: "A" } } });
  conn.close();
  r.dispose();
});

test("burst (textarea): type, Tab, Enter with zero delay submits the typed character, not the default empty string", async () => {
  const r = await mount("form-it-burst-textarea", BURST_TEXTAREA);
  const conn = await openConnection("form-it-burst-textarea");

  r.stdin.write("x");
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { notes: "x" } } });
  conn.close();
  r.dispose();
});

test("burst (optional number): type, Tab, Enter with zero delay submits the typed digit, not an omitted/default value", async () => {
  const r = await mount("form-it-burst-number-optional", BURST_NUMBER_OPTIONAL);
  const conn = await openConnection("form-it-burst-number-optional");

  r.stdin.write("7");
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { count: 7 } } });
  conn.close();
  r.dispose();
});

test("burst (required number): type, Tab, Enter with zero delay submits the typed digit and is not flagged missing", async () => {
  const r = await mount("form-it-burst-number-required", BURST_NUMBER_REQUIRED);
  const conn = await openConnection("form-it-burst-number-required");

  r.stdin.write("7");
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { count: 7 } } });
  const frame = await r.settle();
  expect(frame).not.toContain("<- required");
  conn.close();
  r.dispose();
});

test("burst (checkbox): toggle, Tab, Enter with zero delay submits true, not the untouched false default", async () => {
  const r = await mount("form-it-burst-checkbox", BURST_CHECKBOX);
  const conn = await openConnection("form-it-burst-checkbox");

  r.stdin.write(" ");
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { urgent: true } } });
  conn.close();
  r.dispose();
});

test("burst (select): change, Tab, Enter with zero delay submits the changed option, not the untouched default", async () => {
  const r = await mount("form-it-burst-select", BURST_SELECT);
  const conn = await openConnection("form-it-burst-select");

  r.stdin.write(RIGHT);
  r.stdin.write(TAB);
  r.stdin.write(ENTER);
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({ type: "selected", data: { values: { level: "b" } } });
  conn.close();
  r.dispose();
});

// The compound case the reviewer specifically called out: two DIFFERENT
// fields each edited in the same zero-delay burst. This is the scenario
// that a partial, single-site ref patch would most plausibly still get
// wrong even after "fixing" the first field it was tested against.
test("burst (compound): toggling a checkbox then changing a select then Tab then Enter, all zero delay, submits BOTH new values", async () => {
  const r = await mount("form-it-burst-compound", BURST_COMPOUND);
  const conn = await openConnection("form-it-burst-compound");

  r.stdin.write(" "); // toggle checkbox (focus 0)
  r.stdin.write(TAB); // move to select (focus 1)
  r.stdin.write(RIGHT); // change select a -> b
  r.stdin.write(TAB); // move to Submit (focus 2)
  r.stdin.write(ENTER); // submit
  await r.settle();

  const msg = await nextOutcome(conn, 2000);
  expect(msg).toEqual({
    type: "selected",
    data: { values: { urgent: true, level: "b" } },
  });
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
