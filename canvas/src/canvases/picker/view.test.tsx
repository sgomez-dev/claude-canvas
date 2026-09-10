import { test, expect } from "bun:test";
import React from "react";
import { PickerView } from "./view";
import { renderCanvas } from "../../../test/harness/render";
import type { PickerOption } from "./types";

function lineCount(frame: string): number {
  // Strips ANSI colour codes the same way tree/view.test.tsx does, so a
  // coloured cursor row doesn't inflate the count with escape bytes that
  // never occupy a row of their own.
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((l) => l.length > 0).length;
}

// 30 options, every label a realistic-length branch name (~45 columns),
// mirroring the exact scenario an independent reviewer reproduced: a picker
// over a branch list, budget 12, at 50 columns. This view's windowing math
// assumed every option costs exactly one terminal row -- true only if the
// label never wraps. Before the fix this rendered 18 rows for a budget of
// 12 (each of the 6 visible long labels wrapped onto 2 rows).
const LONG_LABEL_OPTIONS: PickerOption[] = Array.from({ length: 30 }, (_, i) => ({
  id: `opt-${i + 1}`,
  label: `feature/some-fairly-long-branch-name-number-${i + 1}`,
}));

test("30 options with realistic branch-name labels do not exceed their budget at 50 columns", async () => {
  const r = renderCanvas(
    <PickerView
      options={LONG_LABEL_OPTIONS}
      mode="single"
      rows={12}
      columns={50}
      focused
      onSubmit={() => {}}
    />,
    { columns: 50, rows: 30 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});

// A long label must be visibly cut, not silently shortened -- the reader
// needs to know it isn't the whole label.
test("a long option label renders as one row with a visible truncation indicator", async () => {
  const r = renderCanvas(
    <PickerView
      options={LONG_LABEL_OPTIONS}
      mode="single"
      rows={12}
      columns={50}
      focused
      onSubmit={() => {}}
    />,
    { columns: 50, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  // Every option row (between the title and the blank margin/footer) is
  // exactly one physical line: the raw 45-character label plus its 2-column
  // cursor/indent prefix (47) does not fit the 46-column inner width at 50
  // columns, so it must have been truncated to fit, not wrapped onto a
  // second line.
  const optionLines = lines.filter((l) => l.includes("feature/some-fairly-long-branch-name"));
  expect(optionLines.length).toBe(6); // one line per visible option, no wrapping
  for (const line of optionLines) {
    expect(line).toContain("…");
  }
  r.dispose();
});

// Same scenario, harder: multi-select mode's extra checkbox prefix ("[x] "/
// "[ ] ", 4 more columns than single-select's) leaves even less room for the
// label, so this is the sibling path CLAUDE.md's "Verifying a fix" section
// warns a fix can pass for one mode and not the other.
test("multi-select mode also truncates long labels to one row within budget", async () => {
  const r = renderCanvas(
    <PickerView
      options={LONG_LABEL_OPTIONS}
      mode="multi"
      rows={12}
      columns={50}
      focused
      onSubmit={() => {}}
    />,
    { columns: 50, rows: 30 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});

// A description, when present, is part of the same truncatable text as the
// label -- not a second independent field that can still overflow on its
// own.
test("a long description is truncated along with the label", async () => {
  const options: PickerOption[] = [
    {
      id: "opt-1",
      label: "Short",
      description:
        "a description so long it would never fit next to the label at any narrow terminal width",
    },
  ];
  const r = renderCanvas(
    <PickerView options={options} mode="single" rows={12} columns={40} focused onSubmit={() => {}} />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  const optionLines = lines.filter((l) => l.includes("Short"));
  expect(optionLines.length).toBe(1);
  expect(optionLines[0]).toContain("…");
  r.dispose();
});

// Part (a) of the fix: the prompt line is measured with the same
// `wrappedLineCount` helper as the footer, instead of a flat one-row
// assumption. Before the fix, this wrapped onto 3 rows at 30 columns and
// rendered 14 rows for a budget of 12.
test("a wrapping prompt at a narrow width does not push the frame past its budget", async () => {
  const options: PickerOption[] = Array.from({ length: 5 }, (_, i) => ({
    id: `opt-${i + 1}`,
    label: `Option ${i + 1}`,
  }));
  const prompt = "Pick the branch you would like to deploy to production right now";
  const r = renderCanvas(
    <PickerView
      options={options}
      mode="single"
      prompt={prompt}
      rows={12}
      columns={30}
      focused
      onSubmit={() => {}}
    />,
    { columns: 30, rows: 30 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});
