# Picker Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `picker` canvas — choose one or more options from a list, generically (not tied to any domain like calendar times).

**Architecture:** A React/Ink component renders a navigable option list, tracks selection state locally (a single highlighted id in `single` mode, a set of checked ids in `multi` mode), and on confirm calls `sendSelected` via `useCanvasServer`. Registered as canvas kind `picker`, scenario `select`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), React 19, Ink 6, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-generic-primitives-design.md` — read the "Primitive 2: Picker" section and "Shared architecture" section before starting. This plan implements only the Picker primitive; diff/form/table are separate plans.

## Global Constraints

- **No new dependencies.**
- **TypeScript strict, `noUncheckedIndexedAccess` enabled.** Guard, default, or assert-with-stated-invariant on every array/index access.
- **Bun is the only runtime.** Check `where bun` first; if it fails, locate the machine's Bun install path and use it explicitly for every command.
- **Run `bun test` and `bun x tsc --noEmit` only from the repository root.**
- **Render snapshots must show zero diff on an unrelated re-run.** A snapshot change is a real regression — fix the code, never regenerate to match a bug.
- **A canvas process always exits 0**, including on error paths. Never `console.log`/`console.error` from canvas-side code.
- **Config passes by file** (`--config-file`), never raw JSON on a command line.
- **Every new canvas kind must be added to `cli.ts`'s `KNOWN_KINDS` set.**

---

## File Structure

| Path | Responsibility |
|---|---|
| `canvas/src/canvases/picker/types.ts` | `PickerOption`, `PickerConfig`, `PickerResult` |
| `canvas/src/canvases/picker.tsx` | The `Picker` canvas component |
| `canvas/src/scenarios/picker/select.ts` | Scenario definition |
| `canvas/test/snapshots/picker.test.tsx` | Render snapshot tests |
| `canvas/test/integration/picker.test.tsx` | Real-socket IPC test |

**Modified:** `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/scenarios/registry.test.ts`.

---

### Task 1: Picker types and component

**Files:**
- Create: `canvas/src/canvases/picker/types.ts`
- Create: `canvas/src/canvases/picker.tsx`

**Interfaces:**
- Consumes: `useCanvasServer` (existing, `canvas/src/runtime/use-canvas-server.ts`).
- Produces: `PickerOption`, `PickerConfig`, `PickerResult` types; `export function Picker(props: { id: string; config?: PickerConfig; scenario?: string; enabled: boolean }): React.JSX.Element`.

- [ ] **Step 1: Write the types**

`canvas/src/canvases/picker/types.ts`:

```ts
export interface PickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface PickerConfig {
  title?: string;
  prompt?: string;
  mode: "single" | "multi";
  options: PickerOption[];
}

export interface PickerResult {
  selectedIds: string[];
}
```

- [ ] **Step 2: Write the component**

`canvas/src/canvases/picker.tsx`:

```tsx
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { PickerConfig, PickerResult } from "./picker/types";

export interface PickerProps {
  id: string;
  config?: PickerConfig;
  scenario?: string;
  enabled: boolean;
}

function firstEnabledIndex(options: PickerConfig["options"]): number {
  const idx = options.findIndex((o) => !o.disabled);
  return idx === -1 ? 0 : idx;
}

export function Picker({ id, config, scenario = "select", enabled }: PickerProps): React.JSX.Element {
  const { exit } = useApp();
  const options = config?.options ?? [];
  const mode = config?.mode ?? "single";

  const [cursor, setCursor] = useState(() => firstEnabledIndex(options));
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const ipc = useCanvasServer({
    id,
    kind: "picker",
    scenario,
    enabled,
    onClose: () => {},
  });

  function moveCursor(delta: number) {
    if (options.length === 0) return;
    let next = cursor;
    for (let attempts = 0; attempts < options.length; attempts++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setCursor(next);
  }

  function submit(ids: string[]) {
    const result: PickerResult = { selectedIds: ids };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    if (options.length === 0) return;
    if (key.upArrow || input === "k") {
      moveCursor(-1);
    } else if (key.downArrow || input === "j") {
      moveCursor(1);
    } else if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
    } else if (mode === "single" && key.return) {
      const opt = options[cursor];
      if (opt && !opt.disabled) submit([opt.id]);
    } else if (mode === "multi" && input === " ") {
      const opt = options[cursor];
      if (opt && !opt.disabled) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(opt.id)) next.delete(opt.id);
          else next.add(opt.id);
          return next;
        });
      }
    } else if (mode === "multi" && key.return) {
      submit(Array.from(checked));
    }
  });

  if (options.length === 0) {
    return (
      <Box borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">No options to choose from.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Choose"}</Text>
      {config?.prompt ? <Text dimColor>{config.prompt}</Text> : null}
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isChecked = mode === "multi" && checked.has(opt.id);
        const prefix = mode === "multi" ? (isChecked ? "[x] " : "[ ] ") : isCursor ? "> " : "  ";
        return (
          <Text
            key={opt.id}
            color={opt.disabled ? undefined : isCursor ? "cyan" : undefined}
            dimColor={opt.disabled}
          >
            {prefix}
            {opt.label}
            {opt.description ? ` — ${opt.description}` : ""}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {mode === "single"
            ? "↑/↓: navigate  Enter: select  Esc: cancel"
            : "↑/↓: navigate  Space: toggle  Enter: submit  Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Confirm it compiles**

Run: `bun x tsc --noEmit` from repo root.
Expected: no new errors attributable to `canvas/src/canvases/picker.tsx` or `canvas/src/canvases/picker/*`.

- [ ] **Step 4: Commit**

```bash
git add canvas/src/canvases/picker/types.ts canvas/src/canvases/picker.tsx
git commit -m "feat(picker): Picker canvas component with single/multi select"
```

---

### Task 2: Scenario registration and CLI wiring

**Files:**
- Create: `canvas/src/scenarios/picker/select.ts`
- Modify: `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.test.ts`

**Interfaces:**
- Consumes: `ScenarioDefinition` (existing); `Picker` (Task 1).
- Produces: `pickerSelectScenario: ScenarioDefinition`.

- [ ] **Step 1: Write the scenario definition**

`canvas/src/scenarios/picker/select.ts`:

```ts
import type { ScenarioDefinition } from "../types";

export const pickerSelectScenario: ScenarioDefinition = {
  name: "select",
  description: "Choose one or more options from a list",
  canvasKind: "picker",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
```

- [ ] **Step 2: Register it**

`canvas/src/scenarios/registry.ts`: import `pickerSelectScenario` and add `registry.set("picker:select", pickerSelectScenario);`.
`canvas/src/scenarios/index.ts`: add `export * from "./picker/select";`.

- [ ] **Step 3: Wire the render dispatcher**

In `canvas/src/canvases/index.tsx`, add a `case "picker":` branch to `renderCanvas`'s switch, mirroring the existing canvas cases.

- [ ] **Step 4: Add to KNOWN_KINDS**

In `canvas/src/cli.ts`, add `"picker"` to `KNOWN_KINDS`.

- [ ] **Step 5: Test discoverability**

Add to `canvas/src/scenarios/registry.test.ts`:

```ts
test("picker:select is registered", () => {
  expect(getScenario("picker", "select")).toBeDefined();
});
```

Run: `bun test canvas/src/scenarios/registry.test.ts` — expect PASS.

- [ ] **Step 6: Confirm suite and typecheck clean**

Run: `bun x tsc --noEmit` from repo root — expect 0 errors.
Run: `bun test` from repo root — expect all passing.

- [ ] **Step 7: Commit**

```bash
git add canvas/src/scenarios/picker canvas/src/scenarios/registry.ts canvas/src/scenarios/index.ts canvas/src/scenarios/registry.test.ts canvas/src/canvases/index.tsx canvas/src/cli.ts
git commit -m "feat(picker): register picker:select scenario and wire CLI/render dispatch"
```

---

### Task 3: Render snapshot tests

**Files:**
- Create: `canvas/test/snapshots/picker.test.tsx`

**Interfaces:**
- Consumes: `renderCanvas` harness (Phase 1); `Picker` (Task 1).

- [ ] **Step 1: Write the snapshot tests**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import { renderCanvas } from "../harness/render";

const SINGLE_CONFIG = {
  title: "Pick one",
  mode: "single" as const,
  options: [
    { id: "a", label: "Option A", description: "the first one" },
    { id: "b", label: "Option B" },
    { id: "c", label: "Option C (unavailable)", disabled: true },
  ],
};

const MULTI_CONFIG = {
  title: "Pick any",
  mode: "multi" as const,
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ],
};

test("picker renders single-select mode", async () => {
  const r = renderCanvas(<Picker id="picker-1" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker renders multi-select mode", async () => {
  const r = renderCanvas(<Picker id="picker-2" config={MULTI_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker renders an empty-options error state", async () => {
  const r = renderCanvas(
    <Picker id="picker-3" config={{ mode: "single", options: [] }} enabled={false} />,
    { columns: 60, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker is deterministic across renders", async () => {
  const a = renderCanvas(<Picker id="picker-4" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Picker id="picker-4" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
```

- [ ] **Step 2: Run and confirm snapshot stability**

Run: `bun test canvas/test/snapshots/picker.test.tsx` (from repo root) twice.
Expected: first run PASS and writes `.snap`; second run PASS with no rewrite.

- [ ] **Step 3: Commit**

```bash
git add canvas/test/snapshots/picker.test.tsx canvas/test/snapshots/__snapshots__/picker.test.tsx.snap
git commit -m "test(picker): render snapshots"
```

---

### Task 4: Real-socket IPC integration test

**Files:**
- Create: `canvas/test/integration/picker.test.tsx`

**Interfaces:**
- Consumes: `Picker` (Task 1); `renderCanvas` harness with a `stdin` handle (Phase 1, possibly extended by the diff plan's Task 5 — if `canvas/test/harness/render.tsx` does not yet expose `stdin` on its return value, add it now following the same pattern: export the `TestStdin` instance used for a render as `stdin` alongside `frame`/`settle`/`dispose`, without altering any other existing field); `readRecord`/`deleteRecord`, `openConnection` (Phase 1).

- [ ] **Step 1: Write the test**

```tsx
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const SINGLE_CONFIG = {
  mode: "single" as const,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

const MULTI_CONFIG = {
  mode: "multi" as const,
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ],
};

test("single mode: pressing Enter on the highlighted option selects it", async () => {
  const id = "picker-it-1";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\r"); // Enter, on the first (default-highlighted) option
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["a"] } });
  conn.close();
  r.dispose();
});

test("single mode: moving down then selecting picks the second option", async () => {
  const id = "picker-it-2";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["b"] } });
  conn.close();
  r.dispose();
});

test("multi mode: toggling both options and submitting returns both ids", async () => {
  const id = "picker-it-3";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={MULTI_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write(" "); // toggle x
  await r.settle();
  r.stdin.write("j"); // move to y
  await r.settle();
  r.stdin.write(" "); // toggle y
  await r.settle();
  r.stdin.write("\r"); // submit
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { selectedIds: ["x", "y"] } });
  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const id = "picker-it-4";
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={SINGLE_CONFIG} enabled={true} />, {
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

Run: `bun test canvas/test/integration/picker.test.tsx` from repo root.
Expected: FAIL initially. If it fails specifically because `renderCanvas`'s return value has no `stdin` field, add it to the harness per the instruction in Interfaces above, then re-run.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test canvas/test/integration/picker.test.tsx` from repo root.
Expected: PASS, 4 tests.

- [ ] **Step 4: Run the full suite**

Run: `bun test` from repo root — expect PASS, zero snapshot diffs.
Run: `bun x tsc --noEmit` from repo root — expect 0 errors.

- [ ] **Step 5: Commit**

```bash
git add canvas/test/integration/picker.test.tsx canvas/test/harness/render.tsx
git commit -m "test(picker): real-socket IPC integration tests"
```

## Self-Review

**Spec coverage:** Data model, both modes' interaction rules including `disabled` handling, empty-options error, and all three testing layers (component-level, snapshot, IPC integration) are each covered by a task above. `KNOWN_KINDS` and scenario registration covered in Task 2.

**Placeholder scan:** None found — every step has complete, concrete code.

**Type consistency:** `PickerConfig`/`PickerResult` (Task 1) used identically by the component (Task 1), scenario (Task 2), and both test files (Tasks 3-4). The component is named `Picker` everywhere it is imported.
