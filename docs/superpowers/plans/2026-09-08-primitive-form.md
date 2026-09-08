# Form Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `form` canvas — fill in a small set of structured fields (text, textarea, select, checkbox, number) and submit them as one result.

**Architecture:** A React/Ink component holds one focus index that ranges over `[0..fields.length]`, where the final position is a "Submit" pseudo-field. `Tab`/`Shift+Tab` move focus; each real field type has its own key handling for editing its value; `Enter` on the Submit position validates and, if valid, calls `sendSelected`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), React 19, Ink 6, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-generic-primitives-design.md` — read the "Primitive 3: Form" section and "Shared architecture" section before starting. This plan implements only the Form primitive; diff/picker/table are separate plans.

## Global Constraints

- **No new dependencies.**
- **TypeScript strict, `noUncheckedIndexedAccess` enabled.**
- **Bun is the only runtime.** Check `where bun` first; if it fails, locate the machine's Bun install path and use it explicitly.
- **Run `bun test` and `bun x tsc --noEmit` only from the repository root.**
- **Render snapshots must show zero diff on an unrelated re-run.**
- **A canvas process always exits 0.** Never `console.log`/`console.error` from canvas-side code.
- **Config passes by file** (`--config-file`), never raw JSON on a command line.
- **Every new canvas kind must be added to `cli.ts`'s `KNOWN_KINDS` set.**

## One deliberate simplification versus the spec's wording, decided here rather than left ambiguous

The spec says `select` "cycles its options with the left/right arrows **or** opens/closes on `Enter`" — read as an *or*, not a requirement to build both. This plan implements left/right-arrow cycling only. A real expand/collapse overlay would need its own nested-focus state machine, which is disproportionate for this primitive's first cut and not requested by any stated success criterion. If a future need for a searchable/overlay select appears, it is a follow-up, not a gap in this plan.

---

## File Structure

| Path | Responsibility |
|---|---|
| `canvas/src/canvases/form/types.ts` | `FormField`, `FormConfig`, `FormResult` |
| `canvas/src/canvases/form.tsx` | The `Form` canvas component |
| `canvas/src/scenarios/form/fill.ts` | Scenario definition |
| `canvas/test/snapshots/form.test.tsx` | Render snapshot tests |
| `canvas/test/integration/form.test.tsx` | Real-socket IPC test |

**Modified:** `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/scenarios/registry.test.ts`.

---

### Task 1: Form types and component

**Files:**
- Create: `canvas/src/canvases/form/types.ts`
- Create: `canvas/src/canvases/form.tsx`

**Interfaces:**
- Consumes: `useCanvasServer` (existing).
- Produces: `FormField`, `FormConfig`, `FormResult` types; `export function Form(props: { id: string; config?: FormConfig; scenario?: string; enabled: boolean }): React.JSX.Element`.

- [ ] **Step 1: Write the types**

`canvas/src/canvases/form/types.ts`:

```ts
export type FormField =
  | { id: string; type: "text"; label: string; placeholder?: string; required?: boolean }
  | { id: string; type: "textarea"; label: string; placeholder?: string; required?: boolean }
  | {
      id: string;
      type: "select";
      label: string;
      options: Array<{ value: string; label: string }>;
      required?: boolean;
    }
  | { id: string; type: "checkbox"; label: string }
  | { id: string; type: "number"; label: string; min?: number; max?: number; required?: boolean };

export interface FormConfig {
  title?: string;
  fields: FormField[];
}

export interface FormResult {
  values: Record<string, string | number | boolean>;
}
```

- [ ] **Step 2: Write the component**

`canvas/src/canvases/form.tsx`:

```tsx
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { FormConfig, FormField, FormResult } from "./form/types";

export interface FormProps {
  id: string;
  config?: FormConfig;
  scenario?: string;
  enabled: boolean;
}

type FieldState = string | boolean; // number fields store their raw digit string here too

function initialValue(field: FormField): FieldState {
  if (field.type === "checkbox") return false;
  if (field.type === "select") return field.options[0]?.value ?? "";
  return "";
}

function isMissing(field: FormField, value: FieldState): boolean {
  if (!("required" in field) || !field.required) return false;
  if (field.type === "text" || field.type === "textarea" || field.type === "number") {
    return typeof value === "string" && value.trim().length === 0;
  }
  return false; // select always has a value once options are non-empty; checkbox has no required
}

function clampNumber(raw: string, min: number | undefined, max: number | undefined): string {
  if (raw.trim().length === 0) return raw;
  let n = Number(raw);
  if (Number.isNaN(n)) return raw;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return String(n);
}

export function Form({ id, config, scenario = "fill", enabled }: FormProps): React.JSX.Element {
  const { exit } = useApp();
  const fields = config?.fields ?? [];

  const [values, setValues] = useState<Record<string, FieldState>>(() => {
    const init: Record<string, FieldState> = {};
    for (const f of fields) init[f.id] = initialValue(f);
    return init;
  });
  const [focusIndex, setFocusIndex] = useState(0); // fields.length === the Submit position
  const [errors, setErrors] = useState<Set<string>>(new Set());

  const ipc = useCanvasServer({
    id,
    kind: "form",
    scenario,
    enabled,
    onClose: () => {},
  });

  function moveFocus(delta: number) {
    const currentField = fields[focusIndex];
    if (currentField?.type === "number") {
      setValues((prev) => ({
        ...prev,
        [currentField.id]: clampNumber(prev[currentField.id] as string, currentField.min, currentField.max),
      }));
    }
    const total = fields.length + 1; // + Submit
    setFocusIndex((i) => (i + delta + total) % total);
  }

  function attemptSubmit() {
    const missing = new Set<string>();
    for (const f of fields) {
      if (isMissing(f, values[f.id] ?? initialValue(f))) missing.add(f.id);
    }
    if (missing.size > 0) {
      setErrors(missing);
      const firstMissingIndex = fields.findIndex((f) => missing.has(f.id));
      if (firstMissingIndex !== -1) setFocusIndex(firstMissingIndex);
      return;
    }
    const outValues: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      const v = values[f.id] ?? initialValue(f);
      if (f.type === "checkbox") {
        outValues[f.id] = Boolean(v);
      } else if (f.type === "number") {
        const raw = v as string;
        outValues[f.id] = raw.trim().length === 0 ? 0 : Number(clampNumber(raw, f.min, f.max));
      } else {
        outValues[f.id] = v as string;
      }
    }
    const result: FormResult = { values: outValues };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }

    const onSubmit = focusIndex === fields.length;
    if (onSubmit) {
      if (key.return) attemptSubmit();
      return;
    }

    const field = fields[focusIndex];
    if (!field) return;
    const current = values[field.id] ?? initialValue(field);

    if (field.type === "checkbox") {
      if (input === " ") setValues((prev) => ({ ...prev, [field.id]: !prev[field.id] }));
      return;
    }
    if (field.type === "select") {
      const opts = field.options;
      if (opts.length === 0) return;
      const currentIndex = Math.max(0, opts.findIndex((o) => o.value === current));
      if (key.leftArrow) {
        const next = opts[(currentIndex - 1 + opts.length) % opts.length]!;
        setValues((prev) => ({ ...prev, [field.id]: next.value }));
      } else if (key.rightArrow) {
        const next = opts[(currentIndex + 1) % opts.length]!;
        setValues((prev) => ({ ...prev, [field.id]: next.value }));
      }
      return;
    }
    if (field.type === "number") {
      const raw = (current as string) ?? "";
      if (key.backspace || key.delete) {
        setValues((prev) => ({ ...prev, [field.id]: raw.slice(0, -1) }));
      } else if (/^[0-9]$/.test(input)) {
        setValues((prev) => ({ ...prev, [field.id]: raw + input }));
      } else if (input === "-" && raw.length === 0 && (field.min ?? -1) < 0) {
        setValues((prev) => ({ ...prev, [field.id]: raw + input }));
      }
      return;
    }
    // text or textarea
    const text = (current as string) ?? "";
    if (key.backspace || key.delete) {
      setValues((prev) => ({ ...prev, [field.id]: text.slice(0, -1) }));
    } else if (field.type === "textarea" && key.return) {
      setValues((prev) => ({ ...prev, [field.id]: text + "\n" }));
    } else if (input && !key.return) {
      setValues((prev) => ({ ...prev, [field.id]: text + input }));
    }
  });

  if (fields.length === 0) {
    return (
      <Box borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">No fields to fill in.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Fill in the form"}</Text>
      {fields.map((f, i) => {
        const isFocused = i === focusIndex;
        const hasError = errors.has(f.id);
        const value = values[f.id] ?? initialValue(f);
        const labelColor = hasError ? "red" : isFocused ? "cyan" : undefined;
        const requiredMark = "required" in f && f.required ? " *" : "";
        return (
          <Box key={f.id} flexDirection="column">
            <Text color={labelColor}>
              {isFocused ? "> " : "  "}
              {f.label}
              {requiredMark}
            </Text>
            <Box marginLeft={2}>
              {f.type === "checkbox" ? (
                <Text>{value ? "[x]" : "[ ]"}</Text>
              ) : f.type === "select" ? (
                <Text>
                  {"< "}
                  {f.options.find((o) => o.value === value)?.label ?? ""}
                  {" >"}
                </Text>
              ) : (
                <Text dimColor={!value && Boolean(f.placeholder)}>
                  {(value as string) || f.placeholder || ""}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={focusIndex === fields.length ? "cyan" : undefined} bold={focusIndex === fields.length}>
          {focusIndex === fields.length ? "> " : "  "}[ Submit ]
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Tab/Shift+Tab: move  Enter: submit (on the button)  Esc: cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Confirm it compiles**

Run: `bun x tsc --noEmit` from repo root.
Expected: no new errors attributable to `canvas/src/canvases/form.tsx` or `canvas/src/canvases/form/*`.

- [ ] **Step 4: Commit**

```bash
git add canvas/src/canvases/form/types.ts canvas/src/canvases/form.tsx
git commit -m "feat(form): Form canvas component with 5 field types and validation"
```

---

### Task 2: Scenario registration and CLI wiring

**Files:**
- Create: `canvas/src/scenarios/form/fill.ts`
- Modify: `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, `canvas/src/canvases/index.tsx`, `canvas/src/cli.ts`, `canvas/src/scenarios/registry.test.ts`

**Interfaces:**
- Consumes: `ScenarioDefinition` (existing); `Form` (Task 1).
- Produces: `formFillScenario: ScenarioDefinition`.

- [ ] **Step 1: Write the scenario definition**

`canvas/src/scenarios/form/fill.ts`:

```ts
import type { ScenarioDefinition } from "../types";

export const formFillScenario: ScenarioDefinition = {
  name: "fill",
  description: "Fill in a small set of structured fields",
  canvasKind: "form",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
```

- [ ] **Step 2: Register it**

`canvas/src/scenarios/registry.ts`: import and `registry.set("form:fill", formFillScenario);`.
`canvas/src/scenarios/index.ts`: add `export * from "./form/fill";`.

- [ ] **Step 3: Wire the render dispatcher**

In `canvas/src/canvases/index.tsx`, add a `case "form":` branch to `renderCanvas`'s switch.

- [ ] **Step 4: Add to KNOWN_KINDS**

In `canvas/src/cli.ts`, add `"form"` to `KNOWN_KINDS`.

- [ ] **Step 5: Test discoverability**

Add to `canvas/src/scenarios/registry.test.ts`:

```ts
test("form:fill is registered", () => {
  expect(getScenario("form", "fill")).toBeDefined();
});
```

Run: `bun test canvas/src/scenarios/registry.test.ts` — expect PASS.

- [ ] **Step 6: Confirm suite and typecheck clean**

Run: `bun x tsc --noEmit` from repo root — expect 0 errors.
Run: `bun test` from repo root — expect all passing.

- [ ] **Step 7: Commit**

```bash
git add canvas/src/scenarios/form canvas/src/scenarios/registry.ts canvas/src/scenarios/index.ts canvas/src/scenarios/registry.test.ts canvas/src/canvases/index.tsx canvas/src/cli.ts
git commit -m "feat(form): register form:fill scenario and wire CLI/render dispatch"
```

---

### Task 3: Render snapshot tests

**Files:**
- Create: `canvas/test/snapshots/form.test.tsx`

**Interfaces:**
- Consumes: `renderCanvas` harness (Phase 1); `Form` (Task 1).

- [ ] **Step 1: Write the snapshot tests**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { Form } from "../../src/canvases/form";
import { renderCanvas } from "../harness/render";

const ALL_FIELDS_CONFIG = {
  title: "All Field Types",
  fields: [
    { id: "name", type: "text" as const, label: "Name", placeholder: "your name", required: true },
    { id: "bio", type: "textarea" as const, label: "Bio" },
    {
      id: "color",
      type: "select" as const,
      label: "Favorite color",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
      ],
    },
    { id: "subscribe", type: "checkbox" as const, label: "Subscribe" },
    { id: "age", type: "number" as const, label: "Age", min: 0, max: 120 },
  ],
};

test("form renders all five field types", async () => {
  const r = renderCanvas(<Form id="form-1" config={ALL_FIELDS_CONFIG} enabled={false} />, {
    columns: 70,
    rows: 24,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form renders a no-fields error state", async () => {
  const r = renderCanvas(<Form id="form-2" config={{ fields: [] }} enabled={false} />, {
    columns: 60,
    rows: 10,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("form is deterministic across renders", async () => {
  const a = renderCanvas(<Form id="form-3" config={ALL_FIELDS_CONFIG} enabled={false} />, {
    columns: 70,
    rows: 24,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Form id="form-3" config={ALL_FIELDS_CONFIG} enabled={false} />, {
    columns: 70,
    rows: 24,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
```

- [ ] **Step 2: Run and confirm snapshot stability**

Run: `bun test canvas/test/snapshots/form.test.tsx` (from repo root) twice.
Expected: first run PASS and writes `.snap`; second run PASS with no rewrite.

- [ ] **Step 3: Commit**

```bash
git add canvas/test/snapshots/form.test.tsx canvas/test/snapshots/__snapshots__/form.test.tsx.snap
git commit -m "test(form): render snapshots"
```

---

### Task 4: Real-socket IPC integration test

**Files:**
- Create: `canvas/test/integration/form.test.tsx`

**Interfaces:**
- Consumes: `Form` (Task 1); `renderCanvas` harness with a `stdin` handle (Phase 1, possibly already extended by an earlier-executed plan — if `canvas/test/harness/render.tsx` does not yet expose `stdin` on its return value, add it now: export the `TestStdin` instance used for a render as `stdin` alongside `frame`/`settle`/`dispose`, without altering any other existing field); `readRecord`/`deleteRecord`, `openConnection` (Phase 1).

**Important test-writing note:** simulate typed text one character at a time (`r.stdin.write("h")`, then `r.stdin.write("i")`, ...) rather than writing a multi-character string in one call — Ink's input parsing is not guaranteed to split a multi-character `write()` into separate keypress events, and this project's other primitives' tests follow the same one-character-per-write convention.

- [ ] **Step 1: Write the test**

```tsx
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Form } from "../../src/canvases/form";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

function typeText(r: { stdin: { write(s: string): void }; settle(): Promise<string> }, text: string) {
  return (async () => {
    for (const ch of text) {
      r.stdin.write(ch);
      await r.settle();
    }
  })();
}

const SIMPLE_CONFIG = {
  fields: [{ id: "name", type: "text" as const, label: "Name", required: true }],
};

const CHECKBOX_CONFIG = {
  fields: [{ id: "agree", type: "checkbox" as const, label: "Agree" }],
};

const NUMBER_CONFIG = {
  fields: [{ id: "age", type: "number" as const, label: "Age", min: 0, max: 10 }],
};

test("typing a name and submitting sends the right result", async () => {
  const id = "form-it-1";
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={SIMPLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  await typeText(r, "Ada");
  r.stdin.write("\t"); // Tab to the Submit button
  await r.settle();
  r.stdin.write("\r"); // submit
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { values: { name: "Ada" } } });
  conn.close();
  r.dispose();
});

test("submitting with a required field empty does not send a result", async () => {
  const id = "form-it-2";
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={SIMPLE_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write("\t"); // Tab straight to Submit, leaving "name" empty
  await r.settle();
  r.stdin.write("\r"); // attempt submit
  await r.settle();

  const msg = await conn.next(300); // no message should arrive
  expect(msg).toBeNull();
  conn.close();
  r.dispose();
});

test("checkbox toggles to true and submits as a boolean", async () => {
  const id = "form-it-3";
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={CHECKBOX_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  r.stdin.write(" "); // toggle
  await r.settle();
  r.stdin.write("\t");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { values: { agree: true } } });
  conn.close();
  r.dispose();
});

test("a number typed beyond max is clamped on blur", async () => {
  const id = "form-it-4";
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={NUMBER_CONFIG} enabled={true} />, {
    columns: 60,
    rows: 15,
  });
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);
  await typeText(r, "99"); // max is 10
  r.stdin.write("\t"); // blur triggers the clamp
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "selected", data: { values: { age: 10 } } });
  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const id = "form-it-5";
  ids.push(id);
  const r = renderCanvas(<Form id={id} config={SIMPLE_CONFIG} enabled={true} />, {
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

Run: `bun test canvas/test/integration/form.test.tsx` from repo root.
Expected: FAIL initially. If it fails specifically because `renderCanvas`'s return value has no `stdin` field, add it per the instruction above, then re-run.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test canvas/test/integration/form.test.tsx` from repo root.
Expected: PASS, 5 tests.

- [ ] **Step 4: Run the full suite**

Run: `bun test` from repo root — expect PASS, zero snapshot diffs.
Run: `bun x tsc --noEmit` from repo root — expect 0 errors.

- [ ] **Step 5: Commit**

```bash
git add canvas/test/integration/form.test.tsx canvas/test/harness/render.tsx
git commit -m "test(form): real-socket IPC integration tests"
```

## Self-Review

**Spec coverage:** All five field types, `Tab`-based focus model including the Submit pseudo-field, required-field validation blocking submission and highlighting, `number`'s clamp-on-blur (not mid-keystroke), and the deliberate `select` simplification (documented above rather than silently decided) are each covered. Result-shape correctness per field type (`checkbox`→boolean, `number`→number, rest→string) is tested in Task 4.

**Placeholder scan:** None found.

**Type consistency:** `FormField`/`FormConfig`/`FormResult` (Task 1) used identically across the component, scenario, and both test files. The component is named `Form` everywhere it is imported. `FieldState` is an internal type local to `form.tsx`, never imported elsewhere, so it does not need to match anything outside that file.
