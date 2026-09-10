import { test, expect } from "bun:test";
import React from "react";
import { TreeView } from "./view";
import { renderCanvas } from "../../../test/harness/render";
import type { TreeNode } from "./types";

// 30 flat nodes: enough to force windowing (and so the dynamic "N-M of 30"
// position prefix onto the footer) at a budget of 12.
const NODES: TreeNode[] = Array.from({ length: 30 }, (_, i) => ({
  id: `n${i + 1}`,
  label: `Node ${i + 1}`,
}));

function lineCount(frame: string): number {
  // Strips ANSI colour codes the same way the dashboard integration tests
  // do, so a coloured cursor row doesn't inflate the count with escape
  // bytes that never occupy a row of their own.
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((l) => l.length > 0).length;
}

// At several realistic widths, with 30 nodes and a budget of 12: the footer
// actually rendered is "1-N of 30  " (the dynamic position prefix) followed
// by FOOTER_HINT, not the hint alone. At these widths that combined string
// wraps onto a second line, which a hint-only measurement (what this view
// had before the fix) does not budget for -- so the box grows to 13 lines
// for a 12-line budget, the exact overflow class the other four composable
// views were already fixed for.
for (const columns of [60, 55, 50, 30]) {
  test(`does not exceed its budget at ${columns} columns`, async () => {
    const r = renderCanvas(
      <TreeView nodes={NODES} budget={12} columns={columns} focused onSubmit={() => {}} />,
      { columns, rows: 20 }
    );
    const frame = await r.settle();
    expect(lineCount(frame)).toBeLessThanOrEqual(12);
    r.dispose();
  });
}

// Realistic nested file-tree labels -- long component/module paths, not
// short synthetic ones -- through a real (deeply nested) tree at a narrow
// width. Every visible row is assumed to cost exactly one terminal row;
// before the fix a long label wrapped onto 2+ rows, one overflow row per
// long label on screen.
const REALISTIC_NODES: TreeNode[] = [
  {
    id: "src",
    label: "src/",
    children: [
      {
        id: "src/components",
        label: "components/",
        children: Array.from({ length: 12 }, (_, i) => ({
          id: `src/components/c${i}`,
          label: `SomeReallyLongComponentNameForFile${i}.tsx`,
          badge: "M",
        })),
      },
    ],
  },
];

test("a realistic nested file tree does not exceed its budget at a narrow width", async () => {
  const r = renderCanvas(
    <TreeView nodes={REALISTIC_NODES} budget={12} columns={36} focused onSubmit={() => {}} />,
    { columns: 36, rows: 20 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});

test("a long node label (with badge) renders as one row with a visible truncation indicator", async () => {
  const r = renderCanvas(
    <TreeView nodes={REALISTIC_NODES} budget={12} columns={36} focused onSubmit={() => {}} />,
    { columns: 36, rows: 20 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  const labelLines = lines.filter((l) => l.includes("SomeReallyLongComponent"));
  expect(labelLines.length).toBeGreaterThan(0);
  for (const line of labelLines) {
    expect(line).toContain("…");
  }
  r.dispose();
});

// Part (a) of the fix: the prompt line is measured with the same
// `wrappedLineCount` helper as the footer, instead of a flat one-row
// assumption -- tree was written after the wave that fixed this for the
// other views and never got it at all.
test("a wrapping prompt at a narrow width does not push the frame past its budget", async () => {
  const prompt = "Pick the file you would like to open for review right now";
  const r = renderCanvas(
    <TreeView nodes={NODES} prompt={prompt} budget={12} columns={30} focused onSubmit={() => {}} />,
    { columns: 30, rows: 20 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(12);
  r.dispose();
});

// The real production call site: dashboard.tsx composing a tree region with
// a realistic nested file tree at a genuinely small terminal (36x16), not
// TreeView in isolation -- see dashboard.test.tsx's comment on why the
// isolated fix alone was not sufficient evidence for `columns` actually
// reaching this view in production.
test("through the real Dashboard, a realistic file tree does not overflow at 36x16", async () => {
  const { Dashboard } = await import("../dashboard");
  const r = renderCanvas(
    <Dashboard
      id="tree-dashboard-realistic"
      config={{ regions: [{ id: "files", kind: "tree", config: { nodes: REALISTIC_NODES } }] }}
      enabled={true}
    />,
    { columns: 36, rows: 16 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(16);
  r.dispose();
});
