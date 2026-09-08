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

// Regression test for what the tmux smoke test found: the form pane showed
// "> Who *" with nothing beneath it, because an empty value with no
// `placeholder` rendered an empty <Text> that collapsed. The user was
// typing into a field with no visible extent. Every fixture above gives its
// textarea a placeholder, which is exactly why none of them showed it.
test("an empty field with no placeholder still renders a visible input line", async () => {
  const r = renderCanvas(
    <Form
      id="form-6"
      config={{
        title: "No placeholders anywhere",
        fields: [
          { id: "who", type: "text", label: "Who", required: true },
          { id: "count", type: "number", label: "Count" },
        ],
      }}
      enabled={false}
    />,
    { columns: 60, rows: 14 }
  );
  const frame = await r.settle();
  // The focused field carries the cursor; the unfocused empty one a rule.
  expect(frame).toContain("▏");
  expect(frame).toContain("—");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// A form with more fields than the pane has rows used to render all of them.
// The overflow pushed the Submit button itself out of view, so the form
// could be filled in and not submitted -- worse than picker's or table's
// overflow, which only hid content.
const LONG_CONFIG: FormConfig = {
  title: "Twelve fields",
  fields: Array.from({ length: 12 }, (_, i) => ({
    id: `f${i + 1}`,
    type: "text" as const,
    label: `Field ${i + 1}`,
  })),
};

test("form windows a field list longer than the pane, keeping Submit visible", async () => {
  const r = renderCanvas(<Form id="form-7" config={LONG_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 18,
  });
  const frame = await r.settle();
  expect(frame).toContain("1-5 of 12");
  expect(frame).toContain("[ Submit ]");
  expect(frame).not.toContain("Field 12");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("tabbing past the window pages the fields, and Submit is still reachable", async () => {
  const r = renderCanvas(<Form id="form-8" config={LONG_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 18,
  });
  await r.settle();

  // Five fields fit, so the sixth Tab crosses the boundary.
  for (let i = 0; i < 5; i++) {
    r.stdin.write("\t");
    await r.settle();
  }
  expect(await r.settle()).toContain("6-10 of 12");

  // Tab to the Submit position: it belongs to the last page, so the window
  // lands on the final fields rather than leaving Submit off screen.
  for (let i = 0; i < 7; i++) {
    r.stdin.write("\t");
    await r.settle();
  }
  const frame = await r.settle();
  expect(frame).toContain("> [ Submit ]");
  expect(frame).toContain("8-12 of 12");
  r.dispose();
});
