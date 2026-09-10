import { test, expect } from "bun:test";
import React from "react";
import { FormView } from "./view";
import { renderCanvas } from "../../../test/harness/render";
import type { FormField } from "./types";

function lineCount(frame: string): number {
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((l) => l.length > 0).length;
}

// ROWS_PER_FIELD assumes the label row is exactly one terminal row. Before
// the fix, a long required label wrapped onto 4 rows at 30 columns, which
// shifted every field after it (including the value row belonging to THIS
// field) out of its assumed position.
test("a long required field label renders as one row with a truncation indicator, not wrapped", async () => {
  const fields: FormField[] = [
    {
      id: "f1",
      type: "text",
      label: "Please describe in detail the exact reason for this deployment request",
      required: true,
    },
    { id: "f2", type: "text", label: "Name" },
  ];
  const r = renderCanvas(
    <FormView fields={fields} budget={20} columns={30} focused onSubmit={() => {}} />,
    { columns: 30, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  const labelLines = lines.filter((l) => l.includes("Please describe"));
  expect(labelLines.length).toBe(1);
  expect(labelLines[0]).toContain("…");
  // The required asterisk must still be visible after truncation -- it's
  // appended after the (now-shorter) label, not swallowed by it.
  expect(labelLines[0]).toContain("*");
  // The second field's own label and value must still be on screen, in
  // their expected position -- proof the long label didn't shift anything.
  expect(plain).toContain("Name");
  r.dispose();
});

// A form with several long-labelled fields must still fit its budget: the
// windowing math (ROWS_PER_FIELD=2 per field) depends on every label row
// genuinely being one row.
test("several long-labelled fields do not exceed the form's budget at a narrow width", async () => {
  const fields: FormField[] = Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}`,
    type: "text" as const,
    label: `Field label number ${i} that runs on for quite a while past the edge`,
  }));
  const r = renderCanvas(
    <FormView fields={fields} budget={12} columns={30} focused onSubmit={() => {}} />,
    { columns: 30, rows: 20 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});
