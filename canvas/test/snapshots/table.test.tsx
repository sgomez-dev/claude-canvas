import { test, expect } from "bun:test";
import React from "react";
import { Table } from "../../src/canvases/table";
import type { TableConfig } from "../../src/canvases/table/types";
import { renderCanvas } from "../harness/render";

// `detail` is explicitly narrower than its content, so every row exercises
// the ellipsis path the spec asks for ("at least one cell long enough to
// force truncation"). `name` has no width, so it auto-sizes to its longest
// value.
const CONFIG: TableConfig = {
  title: "Failing tests",
  columns: [
    { key: "id", label: "ID", width: 4 },
    { key: "name", label: "Name" },
    { key: "detail", label: "Detail", width: 12 },
  ],
  rows: [
    { id: "1", name: "protocol", detail: "frame decoder rejects oversized input" },
    { id: "2", name: "registry", detail: "stale record" },
    { id: "3", name: "socket-writer", detail: "partial write is queued and drained" },
    { id: "4", name: "cli", detail: "short" },
  ],
};

test("table renders columns, auto-sized and truncated cells", async () => {
  const r = renderCanvas(<Table id="table-1" config={CONFIG} enabled={false} />, {
    columns: 70,
    rows: 20,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// Regression tests for Fix 2: table/validate.ts used to accept a `rows`
// array containing `null`, a non-object, or a cell holding a nested object
// without rejecting it -- the rendering code then threw when it hit one of
// these (`row[col.key]` on `null` throws; an object cell reaches
// `<Text>{cell}</Text>` and throws React's "Objects are not valid as a
// React child"). Render must succeed and show a validation error, not
// throw.
test("a null row produces a validation error instead of crashing the render", async () => {
  const r = renderCanvas(
    <Table
      id="table-6"
      config={{ ...CONFIG, rows: [{ id: "1", name: "ok", detail: "fine" }, null as never] }}
      enabled={false}
    />,
    { columns: 70, rows: 12 }
  );
  const frame = await r.settle();
  expect(frame).toContain("rows[1]");
  expect(frame).toContain("not an object");
  r.dispose();
});

test("an object-valued cell produces a validation error instead of crashing the render", async () => {
  const r = renderCanvas(
    <Table
      id="table-7"
      config={{
        ...CONFIG,
        rows: [{ id: "1", name: "ok", detail: { nested: true } as never }],
      }}
      enabled={false}
    />,
    { columns: 70, rows: 12 }
  );
  const frame = await r.settle();
  expect(frame).toContain("detail");
  expect(frame).toContain("must be a string");
  r.dispose();
});

test("table renders an explicit no-data state rather than a blank frame", async () => {
  const r = renderCanvas(
    <Table id="table-2" config={{ ...CONFIG, rows: [] }} enabled={false} />,
    { columns: 70, rows: 12 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("table renders a config error state for an empty columns list", async () => {
  const r = renderCanvas(
    <Table id="table-3" config={{ columns: [], rows: [] }} enabled={false} />,
    { columns: 70, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("table is deterministic across renders", async () => {
  const a = renderCanvas(<Table id="table-4" config={CONFIG} enabled={false} />, {
    columns: 70,
    rows: 20,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Table id="table-4" config={CONFIG} enabled={false} />, {
    columns: 70,
    rows: 20,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});


// Every row here mixes widths: CJK (2 columns per ideograph, 1 code unit),
// an astral emoji (2 columns, 2 code units) and a ZWJ family emoji (2
// columns, ELEVEN code units). Measured with String.length these rows
// sheared apart; this snapshot is the proof the column separators line up.
// Built from code points so the fixture is reviewable.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const CJK = cp(0x65e5, 0x672c, 0x8a9e);
const FAMILY = [0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466]
  .map((c) => cp(c))
  .join("");

const WIDE_CONFIG: TableConfig = {
  title: "Mixed-width cells",
  columns: [
    { key: "name", label: "Name", width: 10 },
    { key: "note", label: "Note", width: 13 },
  ],
  rows: [
    { name: "ascii", note: "plain" },
    { name: CJK, note: "CJK cell" },
    { name: cp(0x1f680) + " boost", note: "astral emoji" },
    { name: FAMILY, note: "ZWJ cluster" },
    { name: CJK + CJK, note: "truncated CJK" },
  ],
};

// Regression test for Fix 3's footer-wrap half: at a narrow terminal width
// the footer hint text wraps onto a second line, which the row-budget
// math's flat "one line of hint text" assumption didn't account for.
// Verified at the exact dimensions the independent review reproduced this
// at. Uses columns whose widths comfortably fit a 30-column terminal (fixed
// widths well under the 26-column inner width) so the only thing under
// test is the footer wrap -- CONFIG's own auto-width `name` column wrapping
// its cell content at this narrow a terminal is a separate, pre-existing
// horizontal-fit concern outside Fix 3's row-budget scope.
const NARROW_FIT_CONFIG: TableConfig = {
  title: "Narrow",
  columns: [
    { key: "a", label: "A", width: 5 },
    { key: "b", label: "B", width: 8 },
  ],
  rows: [
    { a: "1", b: "ok" },
    { a: "2", b: "ok" },
  ],
};

test("at a narrow terminal width, the frame never exceeds the terminal's row count", async () => {
  const rows = 12;
  const r = renderCanvas(<Table id="table-8" config={NARROW_FIT_CONFIG} enabled={false} />, {
    columns: 30,
    rows,
  });
  const frame = await r.settle();
  expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
  r.dispose();
});

// Regression test for Fix 2, which is distinct from Fix 3 above: the
// row-budget reservation measured only the STATIC hint string, not the
// dynamic "rows X-Y of Z  " position prefix the footer actually prepends
// once there are more rows than fit -- and that prefix only ever appears
// when the data needs scrolling, which NARROW_FIT_CONFIG above (2 rows,
// never windowed) can never exercise. Many rows are needed here so the
// prefix actually renders and widens the footer enough to wrap it onto a
// second line the old reservation never accounted for. Verified at the
// exact width the independent review reproduced this at.
const MANY_ROWS_CONFIG: TableConfig = {
  title: "Many rows",
  columns: [
    { key: "n", label: "N", width: 4 },
    { key: "name", label: "Name", width: 10 },
  ],
  rows: Array.from({ length: 60 }, (_, i) => ({ n: String(i + 1), name: `row-${i + 1}` })),
};

test("at a narrow terminal width with many rows, the footer's position prefix does not push the frame past the terminal's row count", async () => {
  const rows = 16;
  const r = renderCanvas(<Table id="table-9" config={MANY_ROWS_CONFIG} enabled={false} />, {
    columns: 50,
    rows,
  });
  const frame = await r.settle();
  expect(frame).toContain("rows 1-");
  expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
  r.dispose();
});

test("table aligns cells of mixed display width", async () => {
  const r = renderCanvas(<Table id="table-5" config={WIDE_CONFIG} enabled={false} />, {
    columns: 40,
    rows: 16,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});
