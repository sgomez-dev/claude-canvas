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
