import { test, expect } from "bun:test";
import React from "react";
import { TreeView } from "../../src/canvases/tree/view";
import type { TreeNode } from "../../src/canvases/tree/types";
import { renderCanvas } from "../harness/render";

const NODES: TreeNode[] = [
  {
    id: "src",
    label: "src/",
    children: [
      { id: "src/cli.ts", label: "cli.ts", badge: "M" },
      {
        id: "src/canvases",
        label: "canvases/",
        children: [
          { id: "src/canvases/picker.tsx", label: "picker.tsx" },
          { id: "src/canvases/table.tsx", label: "table.tsx", badge: "+12 -3" },
        ],
      },
    ],
  },
  { id: "docs", label: "docs/", collapsed: true, children: [{ id: "docs/x.md", label: "x.md" }] },
  { id: "readme", label: "README.md", badge: "M" },
];

test("tree renders nesting, badges and a collapsed branch", async () => {
  const r = renderCanvas(
    <TreeView nodes={NODES} title="Changed files" budget={16} focused onSubmit={() => {}} />,
    { columns: 50, rows: 16 }
  );
  const frame = await r.settle();
  // `docs/` starts collapsed, so its child must not be on screen, and the
  // marker says so without relying on colour.
  expect(frame).toContain("▸ docs/");
  expect(frame).not.toContain("x.md");
  expect(frame).toContain("▾ src/");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("right arrow expands a collapsed branch and left arrow folds it back", async () => {
  const r = renderCanvas(
    <TreeView nodes={NODES} title="T" budget={16} focused onSubmit={() => {}} />,
    { columns: 50, rows: 16 }
  );
  await r.settle();

  // Move down to `docs/`: src, cli.ts, canvases/, picker.tsx, table.tsx, docs/
  for (let i = 0; i < 5; i++) {
    r.stdin.write("j");
    await r.settle();
  }
  r.stdin.write("\x1b[C"); // right arrow
  const expanded = await r.settle();
  expect(expanded).toContain("x.md");
  expect(expanded).toContain("▾ docs/");

  r.stdin.write("\x1b[D"); // left arrow
  const folded = await r.settle();
  expect(folded).not.toContain("x.md");
  expect(folded).toContain("▸ docs/");
  r.dispose();
});

test("left arrow on a leaf walks up to its parent", async () => {
  const r = renderCanvas(
    <TreeView nodes={NODES} title="T" budget={16} focused onSubmit={() => {}} />,
    { columns: 50, rows: 16 }
  );
  await r.settle();
  r.stdin.write("j"); // onto cli.ts, a leaf one level deep
  expect(await r.settle()).toContain("> " + "  " + "  cli.ts");

  r.stdin.write("\x1b[D");
  // Folding a leaf has nothing to fold, so it moves to the parent instead --
  // which is what makes the left arrow usable for walking back up.
  expect(await r.settle()).toContain("> ▾ src/");
  r.dispose();
});

test("Enter reports the highlighted node with its path", async () => {
  const picked: Array<{ selectedId: string; path: string[] }> = [];
  const r = renderCanvas(
    <TreeView nodes={NODES} title="T" budget={16} focused onSubmit={(x) => picked.push(x)} />,
    { columns: 50, rows: 16 }
  );
  await r.settle();
  for (let i = 0; i < 4; i++) {
    r.stdin.write("j");
    await r.settle();
  }
  r.stdin.write("\r");
  await r.settle();
  expect(picked).toEqual([
    { selectedId: "src/canvases/table.tsx", path: ["src/", "canvases/", "table.tsx"] },
  ]);
  r.dispose();
});

test("tree windows a listing longer than its budget", async () => {
  const many: TreeNode[] = Array.from({ length: 30 }, (_, i) => ({
    id: `n${i}`,
    label: `node-${i}`,
  }));
  const r = renderCanvas(
    <TreeView nodes={many} title="Many" budget={12} focused onSubmit={() => {}} />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  expect(frame).toContain("1-7 of 30");
  expect(frame).not.toContain("node-29");
  r.dispose();
});

test("tree is deterministic across renders", async () => {
  const a = renderCanvas(
    <TreeView nodes={NODES} title="T" budget={16} focused onSubmit={() => {}} />,
    { columns: 50, rows: 16 }
  );
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(
    <TreeView nodes={NODES} title="T" budget={16} focused onSubmit={() => {}} />,
    { columns: 50, rows: 16 }
  );
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
