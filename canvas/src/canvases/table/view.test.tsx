import { test, expect } from "bun:test";
import React from "react";
import { TableView } from "./view";
import { renderCanvas } from "../../../test/harness/render";

function lineCount(frame: string): number {
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((l) => l.length > 0).length;
}

// MAX_AUTO_WIDTH caps any ONE auto-sized column, but nothing previously
// capped the SUM of every column's width against the terminal -- six
// columns at width 20 each is 120+ columns, comfortably wider than a
// 40-column terminal's 36-column inner width. Before the fix, the header
// row and every data row wrapped onto 2 physical lines each instead of 1,
// the same "row assumed one line, rendered as more" overflow fitCell exists
// to prevent for a single over-wide cell -- just triggered by the ROW's
// total width instead.
test("many wide columns whose summed width exceeds the terminal do not wrap the header or any row", async () => {
  const columns = Array.from({ length: 6 }, (_, i) => ({
    key: `c${i}`,
    label: `Column ${i}`,
    width: 20,
  }));
  const rows = Array.from({ length: 5 }, (_, i) => {
    const row: Record<string, string> = {};
    for (const c of columns) row[c.key] = `value-${i}-${c.key}`;
    return row;
  });
  const r = renderCanvas(
    <TableView columns={columns} rows={rows} budget={20} terminalWidth={40} focused />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => l.length > 0);
  // 2 border rows + title (1) + header (1) + 5 data rows + blank margin (1)
  // + footer (1) = 11, iff nothing wraps. Before the fix this rendered 18:
  // the header wrapped to 3 lines and every data row wrapped to 2.
  expect(lines.length).toBe(11);
  r.dispose();
});

test("shrunk columns still show a truncation indicator where content was cut", async () => {
  const columns = Array.from({ length: 6 }, (_, i) => ({
    key: `c${i}`,
    label: `Column ${i}`,
    width: 20,
  }));
  const rows = [
    Object.fromEntries(columns.map((c) => [c.key, `a very long cell value for ${c.key}`])),
  ];
  const r = renderCanvas(
    <TableView columns={columns} rows={rows} budget={20} terminalWidth={40} focused />,
    { columns: 40, rows: 30 }
  );
  const frame = await r.settle();
  expect(frame).toContain("…");
  r.dispose();
});
