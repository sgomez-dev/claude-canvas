import { test, expect } from "bun:test";
import React from "react";
import { Form } from "../../src/canvases/form";
import type { FormConfig } from "../../src/canvases/form/types";
import { renderCanvas } from "../harness/render";

// One form carrying all five approved field types, per the spec's testing
// section: "a render snapshot covering all five field types in one form,
// including a select mid-cycle and a checkbox in both states".
const FULL_CONFIG: FormConfig = {
  title: "Report a bug",
  fields: [
    { id: "summary", type: "text", label: "Summary", required: true },
    { id: "details", type: "textarea", label: "Details", placeholder: "What happened?" },
    {
      id: "severity",
      type: "select",
      label: "Severity",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
    { id: "regression", type: "checkbox", label: "Is it a regression?" },
    { id: "count", type: "number", label: "Occurrences", min: 1, max: 10 },
  ],
};

test("form renders all five field types", async () => {
  const r = renderCanvas(<Form id="form-1" config={FULL_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 22,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form renders a cycled select and a checked checkbox", async () => {
  const r = renderCanvas(<Form id="form-2" config={FULL_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 22,
  });
  await r.settle();
  // summary -> details -> severity
  r.stdin.write("\t");
  await r.settle();
  r.stdin.write("\t");
  await r.settle();
  r.stdin.write("\x1b[C"); // right arrow: severity low -> high
  await r.settle();
  r.stdin.write("\t"); // -> regression checkbox
  await r.settle();
  r.stdin.write(" "); // check it
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form renders required fields flagged after a failed submit", async () => {
  const r = renderCanvas(<Form id="form-3" config={FULL_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 22,
  });
  await r.settle();
  // Tab past all five fields to land on the Submit button, then submit with
  // the required `summary` still empty.
  for (let i = 0; i < 5; i++) {
    r.stdin.write("\t");
    await r.settle();
  }
  r.stdin.write("\r");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form renders a config error state for a select with no options", async () => {
  const r = renderCanvas(
    <Form
      id="form-4"
      config={{ fields: [{ id: "s", type: "select", label: "Pick", options: [] }] }}
      enabled={false}
    />,
    { columns: 60, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form is deterministic across renders", async () => {
  const a = renderCanvas(<Form id="form-5" config={FULL_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 22,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Form id="form-5" config={FULL_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 22,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
