import { test, expect } from "bun:test";
import React from "react";
import { DiffView } from "./view";
import { renderCanvas } from "../../../test/harness/render";
import type { DiffFile } from "./types";

function lineCount(frame: string): number {
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((l) => l.length > 0).length;
}

const LONG_PATH =
  "packages/some-app/src/features/really-long-feature-name/components/SomeReallyLongComponentFile.tsx";

const FILES: DiffFile[] = [
  {
    oldPath: LONG_PATH,
    newPath: LONG_PATH,
    status: "modified",
    binary: false,
    hunks: [
      {
        id: "h1",
        header:
          "@@ -10,20 +10,25 @@ export function someReallyLongFunctionNameThatDescribesWhatItDoes() {",
        oldStart: 10,
        oldLines: 20,
        newStart: 10,
        newLines: 25,
        lines: [{ type: "context", content: "line one", oldLineNo: 10, newLineNo: 10 }],
      },
    ],
  },
];

// The file-list box and the hunk box each assume every entry/header they
// render costs exactly one terminal row. Before the fix, a realistic
// (100+ column) file path and hunk header each wrapped onto 3-4 rows at 40
// columns instead of being truncated to one, inflating the frame well past
// its budget.
test("a long file path renders as one row with a truncation indicator, not wrapped", async () => {
  const r = renderCanvas(
    <DiffView files={FILES} budget={20} columns={40} focused onSubmit={() => {}} />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  const fileLines = lines.filter((l) => l.includes("packages/some-app"));
  expect(fileLines.length).toBe(1);
  expect(fileLines[0]).toContain("…");
  r.dispose();
});

test("a long hunk header renders as one row with a truncation indicator, not wrapped", async () => {
  const r = renderCanvas(
    <DiffView files={FILES} budget={20} columns={40} focused onSubmit={() => {}} />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  const headerLines = lines.filter((l) => l.includes("@@ -10,20"));
  expect(headerLines.length).toBe(1);
  expect(headerLines[0]).toContain("…");
  r.dispose();
});

// A diff with several long paths must still fit its budget -- the file-list
// window (MAX_FILE_ROWS) depends on every entry row genuinely being one row.
test("several long file paths do not exceed the diff's budget at a narrow width", async () => {
  const files: DiffFile[] = Array.from({ length: 5 }, (_, i) => ({
    oldPath: `${LONG_PATH}-${i}`,
    newPath: `${LONG_PATH}-${i}`,
    status: "modified" as const,
    binary: false,
    hunks: [],
  }));
  const r = renderCanvas(
    <DiffView files={files} budget={14} columns={40} focused onSubmit={() => {}} />,
    { columns: 40, rows: 20 }
  );
  const frame = await r.settle();
  expect(lineCount(frame)).toBeLessThanOrEqual(14);
  r.dispose();
});
