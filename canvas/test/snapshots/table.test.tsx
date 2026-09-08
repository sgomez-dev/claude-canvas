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
