# Table Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `table` canvas — display scrollable tabular data. View-only; no selection concept lives here (deliberately, per the spec — row selection composes with the `picker` primitive instead of being duplicated here).

**Architecture:** A React/Ink component computes an effective width per column (explicit `width`, or auto-sized to the longest value present, capped at 40 characters), renders a fixed header row plus a scrollable window of body rows, and calls `sendCancelled` on close — there is no `sendSelected` path in this primitive at all.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), React 19, Ink 6, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-generic-primitives-design.md` — read the "Primitive 4: Table" section and "Shared architecture" section before starting. This plan implements only the Table primitive; diff/picker/form are separate plans.

## Global Constraints

- **No new dependencies.**
- **TypeScript strict, `noUncheckedIndexedAccess` enabled.**
- **Bun is the only runtime.** Check `where bun` first; if it fails, locate the machine's Bun install path and use it explicitly.
- **Run `bun test` and `bun x tsc --noEmit` only from the repository root.**
- **Render snapshots must show zero diff on an unrelated re-run.**
- **A canvas process always exits 0.** Never `console.log`/`console.error` from canvas-side code.
- **Config passes by file** (`--config-file`), never raw JSON on a command line.
- **Every new canvas kind must be added to `cli.ts`'s `KNOWN_KINDS` set.**
- **Auto column width caps at 40 characters** (the spec's earlier wording, "a reasonable cap," was tightened to this exact number during spec self-review).

---

## File Structure

| Path | Responsibility |
|---|---|
| `canvas/src/canvases/table/types.ts` | `TableColumn`, `TableConfig` |
| `canvas/src/canvases/table.tsx` | The `Table` canvas component |
| `canvas/src/scenarios/table/display.ts` | Scenario definition |
| `canvas/test/snapshots/table.test.tsx` | Render snapshot tests |
| `canvas/test/integration/table.test.tsx` | Real-socket IPC test |

**Modified:** `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/scenarios/registry.test.ts`.

---

### Task 1: Table types and component

**Files:**
- Create: `canvas/src/canvases/table/types.ts`
- Create: `canvas/src/canvases/table.tsx`

**Interfaces:**
- Consumes: `useCanvasServer` (existing).
- Produces: `TableColumn`, `TableConfig` types; `export function Table(props: { id: string; config?: TableConfig; scenario?: string; enabled: boolean }): React.JSX.Element`.

- [ ] **Step 1: Write the types**

`canvas/src/canvases/table/types.ts`:

```ts
export interface TableColumn {
  key: string;
  label: string;
  width?: number;
}

export interface TableConfig {
  title?: string;
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
}
```

- [ ] **Step 2: Write the component**

`canvas/src/canvases/table.tsx`:

```tsx
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { TableConfig, TableColumn } from "./table/types";

export interface TableProps {
  id: string;
  config?: TableConfig;
  scenario?: string;
  enabled: boolean;
}

const MAX_AUTO_WIDTH = 40;
const HEADER_OVERHEAD_ROWS = 6; // borders, title, column header, footer hint

function computeWidth(col: TableColumn, rows: Array<Record<string, string>>): number {
  if (col.width !== undefined) return col.width;
  let longest = col.label.length;
  for (const row of rows) {
    const cell = row[col.key] ?? "";
    if (cell.length > longest) longest = cell.length;
  }
  return Math.min(MAX_AUTO_WIDTH, longest);
}

function fitCell(content: string, width: number): string {
  if (content.length > width) {
    return width <= 1 ? content.slice(0, width) : content.slice(0, width - 1) + "…";
  }
  return content.padEnd(width);
}

export function Table({ id, config, scenario = "display", enabled }: TableProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = config?.columns ?? [];
  const rows = config?.rows ?? [];

  const widths = useMemo(() => columns.map((c) => computeWidth(c, rows)), [columns, rows]);

  const totalTerminalRows = stdout?.rows ?? 24;
  const visibleCount = Math.max(1, totalTerminalRows - HEADER_OVERHEAD_ROWS);

  const [scrollOffset, setScrollOffset] = useState(0);
  const maxOffset = Math.max(0, rows.length - visibleCount);

  const ipc = useCanvasServer({
    id,
    kind: "table",
    scenario,
    enabled,
    onClose: () => {},
  });

  useInput((_input, key) => {
    if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (key.downArrow) {
      setScrollOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.upArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
    } else if (key.pageDown) {
      setScrollOffset((o) => Math.min(maxOffset, o + visibleCount));
    } else if (key.pageUp) {
      setScrollOffset((o) => Math.max(0, o - visibleCount));
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold>{config?.title ?? "Table"}</Text>
        <Text dimColor>No data.</Text>
      </Box>
    );
  }

  const visibleRows = rows.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Table"}</Text>
      <Box>
        {columns.map((c, i) => (
          <Text key={c.key} bold>
            {fitCell(c.label, widths[i]!)}{" "}
          </Text>
        ))}
      </Box>
      {visibleRows.map((row, rowIndex) => (
        <Box key={scrollOffset + rowIndex}>
          {columns.map((c, i) => (
            <Text key={c.key}>
              {fitCell(row[c.key] ?? "", widths[i]!)}{" "}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          {rows.length > visibleCount
            ? `rows ${scrollOffset + 1}-${scrollOffset + visibleRows.length} of ${rows.length}  `
            : ""}
          ↑/↓/PgUp/PgDn: scroll  Esc: close
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Confirm it compiles**

Run: `bun x tsc --noEmit` from repo root.
Expected: no new errors attributable to `canvas/src/canvases/table.tsx` or `canvas/src/canvases/table/*`.

- [ ] **Step 4: Commit**

```bash
git add canvas/src/canvases/table/types.ts canvas/src/canvases/table.tsx
git commit -m "feat(table): Table canvas component, view-only with scrolling"
```

---

### Task 2: Scenario registration and CLI wiring

**Files:**
- Create: `canvas/src/scenarios/table/display.ts`
- Modify: `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.test.ts`

**Interfaces:**
- Consumes: `ScenarioDefinition` (existing); `Table` (Task 1).
- Produces: `tableDisplayScenario: ScenarioDefinition`.

- [ ] **Step 1: Write the scenario definition**

`canvas/src/scenarios/table/display.ts`:

```ts
import type { ScenarioDefinition } from "../types";

export const tableDisplayScenario: ScenarioDefinition = {
  name: "display",
  description: "Display scrollable tabular data, view-only",
  canvasKind: "table",
  interactionMode: "view-only",
  closeOn: "escape",
  defaultConfig: {},
};
```

- [ ] **Step 2: Register it**

`canvas/src/scenarios/registry.ts`: import and `registry.set("table:display", tableDisplayScenario);`.
`canvas/src/scenarios/index.ts`: add `export * from "./table/display";`.

- [ ] **Step 3: Wire the render dispatcher**

In `canvas/src/canvases/index.tsx`, add a `case "table":` branch to `renderCanvas`'s switch.

- [ ] **Step 4: Add to KNOWN_KINDS**

In `canvas/src/cli.ts`, add `"table"` to `KNOWN_KINDS`.

- [ ] **Step 5: Test discoverability**

Add to `canvas/src/scenarios/registry.test.ts`:

```ts
test("table:display is registered", () => {
  expect(getScenario("table", "display")).toBeDefined();
});
```

Run: `bun test canvas/src/scenarios/registry.test.ts` — expect PASS.

- [ ] **Step 6: Confirm suite and typecheck clean**

Run: `bun x tsc --noEmit` from repo root — expect 0 errors.
Run: `bun test` from repo root — expect all passing.

- [ ] **Step 7: Commit**

```bash
git add canvas/src/scenarios/table canvas/src/scenarios/registry.ts canvas/src/scenarios/index.ts canvas/src/scenarios/registry.test.ts canvas/src/canvases/index.tsx canvas/src/cli.ts
git commit -m "feat(table): register table:display scenario and wire CLI/render dispatch"
```

---

### Task 3: Render snapshot tests

**Files:**
- Create: `canvas/test/snapshots/table.test.tsx`

**Interfaces:**
- Consumes: `renderCanvas` harness (Phase 1); `Table` (Task 1).

- [ ] **Step 1: Write the snapshot tests**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { Table } from "../../src/canvases/table";
import { renderCanvas } from "../harness/render";

const SAMPLE_CONFIG = {
  title: "Test Results",
  columns: [
    { key: "name", label: "Test" },
    { key: "status", label: "Status", width: 8 },
    { key: "detail", label: "Detail" },
  ],
  rows: [
    { name: "parses a single file", status: "pass", detail: "ok" },
    { name: "handles a very long test name that should be truncated with an ellipsis", status: "pass", detail: "ok" },
    { name: "rejects malformed input", status: "fail", detail: "expected throw, got none" },
  ],
};

test("table renders sample rows with a truncated cell", async () => {
  const r = renderCanvas(<Table id="table-1" config={SAMPLE_CONFIG} enabled={false} />, {
    columns: 80,
    rows: 20,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("table renders an explicit no-data state for zero rows", async () => {
  const r = renderCanvas(
    <Table id="table-2" config={{ title: "Empty", columns: SAMPLE_CONFIG.columns, rows: [] }} enabled={false} />,
    { columns: 80, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("table is deterministic across renders", async () => {
  const a = renderCanvas(<Table id="table-3" config={SAMPLE_CONFIG} enabled={false} />, {
    columns: 80,
    rows: 20,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Table id="table-3" config={SAMPLE_CONFIG} enabled={false} />, {
    columns: 80,
    rows: 20,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
```

- [ ] **Step 2: Run and confirm snapshot stability**

Run: `bun test canvas/test/snapshots/table.test.tsx` (from repo root) twice.
Expected: first run PASS and writes `.snap`; second run PASS with no rewrite.

- [ ] **Step 3: Commit**

```bash
git add canvas/test/snapshots/table.test.tsx canvas/test/snapshots/__snapshots__/table.test.tsx.snap
git commit -m "test(table): render snapshots"
```

---

### Task 4: Real-socket IPC integration test

**Files:**
- Create: `canvas/test/integration/table.test.tsx`

**Interfaces:**
- Consumes: `Table` (Task 1); `renderCanvas` harness with a `stdin` handle (Phase 1, possibly already extended by an earlier-executed plan — add it to `canvas/test/harness/render.tsx` now if it is still missing, following the same pattern used by the other three primitives' plans: export the `TestStdin` instance as `stdin` alongside `frame`/`settle`/`dispose`); `readRecord`/`deleteRecord`, `openConnection` (Phase 1).

- [ ] **Step 1: Write the test**

```tsx
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Table } from "../../src/canvases/table";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const CONFIG = {
  columns: [{ key: "a", label: "A" }],
  rows: [{ a: "one" }, { a: "two" }],
};

test("escape closes the table and sends cancelled over a real socket", async () => {
  const id = "table-it-1";
  ids.push(id);
  const r = renderCanvas(<Table id={id} config={CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\x1b");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails or reveals a harness gap**

Run: `bun test canvas/test/integration/table.test.tsx` from repo root.
Expected: FAIL initially. If it fails specifically because `renderCanvas`'s return value has no `stdin` field, add it per the instruction above, then re-run.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test canvas/test/integration/table.test.tsx` from repo root.
Expected: PASS, 1 test.

- [ ] **Step 4: Run the full suite**

Run: `bun test` from repo root — expect PASS, zero snapshot diffs.
Run: `bun x tsc --noEmit` from repo root — expect 0 errors.

- [ ] **Step 5: Commit**

```bash
git add canvas/test/integration/table.test.tsx canvas/test/harness/render.tsx
git commit -m "test(table): real-socket IPC integration test"
```

## Self-Review

**Spec coverage:** Auto/explicit column width with the 40-character cap, ellipsis truncation (never wrap), fixed header with scrolling body, explicit no-data state for zero rows, and view-only behavior (`sendCancelled` only, no `sendSelected` path exists in this component at all) are each covered. `KNOWN_KINDS` and scenario registration covered in Task 2.

**Placeholder scan:** None found.

**Type consistency:** `TableColumn`/`TableConfig` (Task 1) used identically across the component, scenario, and both test files. The component is named `Table` everywhere it is imported.
