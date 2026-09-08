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

test("table aligns cells of mixed display width", async () => {
  const r = renderCanvas(<Table id="table-5" config={WIDE_CONFIG} enabled={false} />, {
    columns: 40,
    rows: 16,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});
