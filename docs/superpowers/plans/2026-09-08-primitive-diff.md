# Diff Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `diff` canvas — review a multi-file unified diff hunk by hunk, approve or reject each one, and return the decisions to Claude.

**Architecture:** A pure parser turns unified diff text into a structured `DiffFile[]`. A React/Ink component renders a file list plus the current file's hunks, tracks per-hunk decisions in local state, and on submit calls `sendSelected` via `useCanvasServer`. Registered as canvas kind `diff`, scenario `review`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), React 19, Ink 6, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-generic-primitives-design.md` — read the "Primitive 1: Diff" section and "Shared architecture" section before starting. This plan implements only the Diff primitive; picker/form/table are separate plans.

## Global Constraints

- **No new dependencies.** The parser is hand-written regex/string parsing over the unified diff format.
- **TypeScript strict, `noUncheckedIndexedAccess` enabled.** Every array/index access must be guarded, defaulted, or asserted with a stated invariant — the same three patterns Phase 1 used throughout.
- **Bun is the only runtime.** Bun is likely not on PATH in this environment — check `where bun` first; if it fails, the machine's Bun install path must be located and used explicitly for every command in this plan.
- **Run `bun test` and `bun x tsc --noEmit` only from the repository root.** `bunfig.toml` there preloads `canvas/test/setup.ts`, which pins `FORCE_COLOR` and `TZ` — a guard in `canvas/test/harness/render.tsx` throws a clear error if this is violated.
- **Render snapshots must show zero diff on an unrelated re-run.** If a snapshot changes unexpectedly, that is a real regression — fix the code, never regenerate the snapshot to match a bug.
- **A canvas process always exits 0**, including on error paths. Never `console.log`/`console.error` from canvas-side code — use the pattern already established in `use-canvas-server.ts` (log to the per-canvas log file via `logPath`).
- **Config passes by file** (`--config-file`), never raw JSON on a command line.
- **Every new canvas kind must be added to `cli.ts`'s `KNOWN_KINDS` set** or spawning it is rejected by the injection-closing whitelist added in Phase 1's final review.

---

## File Structure

| Path | Responsibility |
|---|---|
| `canvas/src/canvases/diff/types.ts` | `DiffFile`, `DiffHunk`, `DiffLine`, `DiffReviewConfig`, `DiffReviewResult` |
| `canvas/src/canvases/diff/parser.ts` | `parseUnifiedDiff(text: string): DiffFile[]` |
| `canvas/src/canvases/diff/parser.test.ts` | Parser unit tests against real `git diff` fixtures |
| `canvas/src/canvases/diff.tsx` | The `Diff` canvas component |
| `canvas/src/scenarios/diff/review.ts` | Scenario definition |
| `canvas/test/snapshots/diff.test.tsx` | Render snapshot tests |
| `canvas/test/integration/diff.test.tsx` | Real-socket IPC test for this canvas |

**Modified:**

| Path | Change |
|---|---|
| `canvas/src/canvases/index.tsx` | Add `"diff"` case to `renderCanvas`'s switch |
| `canvas/src/cli.ts` | Add `"diff"` to `KNOWN_KINDS` |
| `canvas/src/scenarios/registry.ts` | Register `diff:review` |
| `canvas/src/scenarios/index.ts` | Export `diffReviewScenario` |

---

### Task 1: Diff types and parser

**Files:**
- Create: `canvas/src/canvases/diff/types.ts`
- Create: `canvas/src/canvases/diff/parser.ts`
- Create: `canvas/src/canvases/diff/parser.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DiffFile`, `DiffHunk`, `DiffLine`, `DiffReviewConfig`, `DiffReviewResult` types; `parseUnifiedDiff(text: string): DiffFile[]`, `class DiffParseError extends Error`.

- [ ] **Step 1: Write the types**

`canvas/src/canvases/diff/types.ts`:

```ts
export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNo?: number; // present for "context" and "remove", absent for "add"
  newLineNo?: number; // present for "context" and "add", absent for "remove"
}

export interface DiffHunk {
  id: string; // `${file.newPath}#${index}`
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
}

export interface DiffReviewConfig {
  title?: string;
  diffText: string;
}

export type HunkDecision = "approved" | "rejected";

export interface DiffReviewResult {
  decisions: Array<{ hunkId: string; decision: HunkDecision }>;
}
```

- [ ] **Step 2: Write the failing parser tests**

`canvas/src/canvases/diff/parser.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { parseUnifiedDiff, DiffParseError } from "./parser";

const SIMPLE_MODIFIED = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@
 line one
-line two
+line two changed
+line three new
 line four
`;

const MULTI_FILE = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old a
+new a
 shared
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-old b
+new b
`;

const ADDED_FILE = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED_FILE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1234567..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;

const RENAMED_FILE = `diff --git a/old-name.txt b/new-name.txt
similarity index 100%
rename from old-name.txt
rename to new-name.txt
`;

const BINARY_FILE = `diff --git a/image.png b/image.png
index 1234567..89abcde 100644
Binary files a/image.png and b/image.png differ
`;

const NO_TRAILING_NEWLINE = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  test("parses a single modified file with one hunk", () => {
    const files = parseUnifiedDiff(SIMPLE_MODIFIED);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.oldPath).toBe("foo.txt");
    expect(file.newPath).toBe("foo.txt");
    expect(file.status).toBe("modified");
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.id).toBe("foo.txt#0");
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines).toEqual([
      { type: "context", content: "line one", oldLineNo: 1, newLineNo: 1 },
      { type: "remove", content: "line two", oldLineNo: 2 },
      { type: "add", content: "line two changed", newLineNo: 2 },
      { type: "add", content: "line three new", newLineNo: 3 },
      { type: "context", content: "line four", oldLineNo: 3, newLineNo: 4 },
    ]);
  });

  test("parses multiple files in one diff", () => {
    const files = parseUnifiedDiff(MULTI_FILE);
    expect(files).toHaveLength(2);
    expect(files[0]!.newPath).toBe("a.txt");
    expect(files[1]!.newPath).toBe("b.txt");
    expect(files[0]!.hunks[0]!.id).toBe("a.txt#0");
    expect(files[1]!.hunks[0]!.id).toBe("b.txt#0");
  });

  test("detects an added file", () => {
    const files = parseUnifiedDiff(ADDED_FILE);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.hunks[0]!.lines.every((l) => l.type === "add")).toBe(true);
  });

  test("detects a deleted file", () => {
    const files = parseUnifiedDiff(DELETED_FILE);
    expect(files[0]!.status).toBe("deleted");
    expect(files[0]!.hunks[0]!.lines.every((l) => l.type === "remove")).toBe(true);
  });

  test("detects a renamed file with no hunks", () => {
    const files = parseUnifiedDiff(RENAMED_FILE);
    expect(files[0]!.status).toBe("renamed");
    expect(files[0]!.oldPath).toBe("old-name.txt");
    expect(files[0]!.newPath).toBe("new-name.txt");
    expect(files[0]!.hunks).toHaveLength(0);
  });

  test("marks a binary file as binary with no hunks, without throwing", () => {
    const files = parseUnifiedDiff(BINARY_FILE);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
  });

  test("handles a missing trailing newline marker without corrupting content", () => {
    const files = parseUnifiedDiff(NO_TRAILING_NEWLINE);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { type: "remove", content: "old", oldLineNo: 1 },
      { type: "add", content: "new", newLineNo: 1 },
    ]);
  });

  test("a hunk header with an implicit length of 1 parses correctly", () => {
    const text = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1 @@
-a
+b
`;
    const hunk = parseUnifiedDiff(text)[0]!.hunks[0]!;
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newLines).toBe(1);
  });

  test("throws DiffParseError on unparseable input", () => {
    expect(() => parseUnifiedDiff("this is not a diff at all\njust some text\n")).toThrow(
      DiffParseError
    );
  });

  test("empty input parses to an empty file list, not an error", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/canvases/diff/parser.test.ts`
Expected: FAIL — cannot resolve module `./parser`.

- [ ] **Step 3: Implement the parser**

`canvas/src/canvases/diff/parser.ts`:

```ts
import type { DiffFile, DiffHunk, DiffLine } from "./types";

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|(\/dev\/null))$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_RE = /^Binary files (.+) and (.+) differ$/;

function splitIntoFileBlocks(text: string): string[] {
  const trimmed = text.replace(/\r\n/g, "\n");
  if (trimmed.trim().length === 0) return [];
  const lines = trimmed.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (FILE_HEADER_RE.test(line) || (OLD_PATH_RE.test(line) && current.length === 0)) {
      if (current.length > 0) blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  if (blocks.length === 0) {
    throw new DiffParseError("Input does not look like a unified diff.");
  }
  return blocks.map((b) => b.join("\n"));
}

function parseFileBlock(block: string, fallbackIndex: number): DiffFile {
  const lines = block.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldIsDevNull = false;
  let newIsDevNull = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let binary = false;
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const gitHeader = FILE_HEADER_RE.exec(line);
    if (gitHeader) {
      oldPath = gitHeader[1];
      newPath = gitHeader[2];
      continue;
    }
    const renameFromMatch = RENAME_FROM_RE.exec(line);
    if (renameFromMatch) {
      renameFrom = renameFromMatch[1];
      continue;
    }
    const renameToMatch = RENAME_TO_RE.exec(line);
    if (renameToMatch) {
      renameTo = renameToMatch[1];
      continue;
    }
    const binaryMatch = BINARY_RE.exec(line);
    if (binaryMatch) {
      binary = true;
      continue;
    }
    const oldMatch = OLD_PATH_RE.exec(line);
    if (oldMatch) {
      if (oldMatch[2]) oldIsDevNull = true;
      else oldPath = oldMatch[1];
      continue;
    }
    const newMatch = NEW_PATH_RE.exec(line);
    if (newMatch) {
      if (newMatch[2]) newIsDevNull = true;
      else newPath = newMatch[1];
      bodyStart = i + 1;
      break;
    }
  }

  if (renameFrom && renameTo) {
    return {
      oldPath: renameFrom,
      newPath: renameTo,
      status: "renamed",
      binary: false,
      hunks: [],
    };
  }

  if (!oldPath && !newPath) {
    throw new DiffParseError(`Could not determine file path in block:\n${block.slice(0, 200)}`);
  }

  const finalOldPath = oldPath ?? newPath!;
  const finalNewPath = newPath ?? oldPath!;
  const status: DiffFile["status"] = oldIsDevNull ? "added" : newIsDevNull ? "deleted" : "modified";

  if (binary) {
    return { oldPath: finalOldPath, newPath: finalNewPath, status, binary: true, hunks: [] };
  }

  const hunks: DiffHunk[] = [];
  let hunkIndex = 0;
  let i = bodyStart;
  while (i >= 0 && i < lines.length) {
    const header = HUNK_HEADER_RE.exec(lines[i]!);
    if (!header) {
      i++;
      continue;
    }
    const oldStart = Number(header[1]);
    const oldLines = header[2] !== undefined ? Number(header[2]) : 1;
    const newStart = Number(header[3]);
    const newLines = header[4] !== undefined ? Number(header[4]) : 1;
    const hunkLines: DiffLine[] = [];
    let oldLineNo = oldStart;
    let newLineNo = newStart;
    i++;
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!) && !FILE_HEADER_RE.test(lines[i]!)) {
      const raw = lines[i]!;
      if (raw.startsWith("\\ No newline")) {
        i++;
        continue;
      }
      if (raw === "" && i === lines.length - 1) {
        i++;
        continue;
      }
      const marker = raw[0];
      const content = raw.slice(1);
      if (marker === "+") {
        hunkLines.push({ type: "add", content, newLineNo: newLineNo++ });
      } else if (marker === "-") {
        hunkLines.push({ type: "remove", content, oldLineNo: oldLineNo++ });
      } else {
        hunkLines.push({ type: "context", content, oldLineNo: oldLineNo++, newLineNo: newLineNo++ });
      }
      i++;
    }
    hunks.push({
      id: `${finalNewPath}#${hunkIndex}`,
      header: lines[bodyStart + (hunks.length === 0 ? 0 : 0)] ?? "",
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: hunkLines,
    });
    hunkIndex++;
  }

  return { oldPath: finalOldPath, newPath: finalNewPath, status, binary: false, hunks };
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const blocks = splitIntoFileBlocks(text);
  return blocks.map((block, index) => parseFileBlock(block, index));
}
```

Note the hunk's `header` field: fix it to capture the actual matched header line text rather than re-deriving it — replace the `header:` line above with the header line captured at match time. Concretely, restructure so `header` is set to `lines[headerLineIndex]!` where `headerLineIndex` is the index at which `HUNK_HEADER_RE` matched, captured in a local variable before advancing `i`. Implement this correctly (store `const headerLine = lines[i]!;` right after `const header = HUNK_HEADER_RE.exec(lines[i]!)` succeeds, before incrementing `i`, and use `header: headerLine` in the pushed object) rather than the placeholder expression shown above.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/canvases/diff/parser.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/canvases/diff/types.ts canvas/src/canvases/diff/parser.ts canvas/src/canvases/diff/parser.test.ts
git commit -m "feat(diff): unified diff parser with types"
```

---

### Task 2: Diff canvas component

**Files:**
- Create: `canvas/src/canvases/diff.tsx`

**Interfaces:**
- Consumes: `parseUnifiedDiff`, `DiffParseError` (Task 1); `DiffFile`, `DiffHunk`, `DiffReviewConfig`, `DiffReviewResult`, `HunkDecision` (Task 1); `useCanvasServer` from `canvas/src/runtime/use-canvas-server.ts` (existing, Phase 1).
- Produces: `export function Diff(props: { id: string; config?: DiffReviewConfig; scenario?: string; enabled: boolean }): JSX.Element`.

- [ ] **Step 1: Write the component**

```tsx
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { parseUnifiedDiff, DiffParseError } from "./diff/parser";
import type { DiffFile, DiffReviewConfig, DiffReviewResult, HunkDecision } from "./diff/types";

export interface DiffProps {
  id: string;
  config?: DiffReviewConfig;
  scenario?: string;
  enabled: boolean;
}

interface FlatHunkRef {
  fileIndex: number;
  hunkIndex: number;
}

export function Diff({ id, config, scenario = "review", enabled }: DiffProps): React.JSX.Element {
  const { exit } = useApp();
  const [parseError, setParseError] = useState<string | null>(null);
  const files: DiffFile[] = useMemo(() => {
    if (!config?.diffText || config.diffText.trim().length === 0) return [];
    try {
      return parseUnifiedDiff(config.diffText);
    } catch (e) {
      setParseError(e instanceof DiffParseError ? e.message : "Failed to parse diff.");
      return [];
    }
  }, [config?.diffText]);

  const flatHunks: FlatHunkRef[] = useMemo(() => {
    const refs: FlatHunkRef[] = [];
    files.forEach((f, fileIndex) => {
      f.hunks.forEach((_h, hunkIndex) => refs.push({ fileIndex, hunkIndex }));
    });
    return refs;
  }, [files]);

  const [cursor, setCursor] = useState(0);
  const [decisions, setDecisions] = useState<Map<string, HunkDecision>>(new Map());

  const ipc = useCanvasServer({
    id,
    kind: "diff",
    scenario,
    enabled,
    onClose: () => {},
  });

  useInput((input, key) => {
    if (files.length === 0) return;
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(flatHunks.length - 1, c + 1));
    } else if (input === "a") {
      const ref = flatHunks[cursor];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "approved"));
      }
    } else if (input === "r") {
      const ref = flatHunks[cursor];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "rejected"));
      }
    } else if (key.return) {
      const result: DiffReviewResult = {
        decisions: flatHunks.map((ref) => {
          const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
          return { hunkId: hunk.id, decision: decisions.get(hunk.id) ?? "rejected" };
        }),
      };
      ipc.sendSelected(result);
      exit();
    } else if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
    }
  });

  if (parseError) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">Failed to parse diff: {parseError}</Text>
      </Box>
    );
  }

  if (files.length === 0) {
    return (
      <Box borderStyle="round" padding={1}>
        <Text dimColor>Nothing to review.</Text>
      </Box>
    );
  }

  const currentRef = flatHunks[cursor];
  const currentFile = currentRef ? files[currentRef.fileIndex] : undefined;
  const currentHunk = currentRef ? currentFile?.hunks[currentRef.hunkIndex] : undefined;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{config?.title ?? "Review Changes"}</Text>
        {files.map((f) => {
          const total = f.hunks.length;
          const decided = f.hunks.filter((h) => decisions.has(h.id)).length;
          const marker = f.binary ? "[binary]" : `${decided}/${total} decided`;
          const isCurrentFile = currentRef?.fileIndex === files.indexOf(f);
          return (
            <Text key={f.newPath} color={isCurrentFile ? "cyan" : undefined}>
              {isCurrentFile ? "> " : "  "}
              {f.newPath} ({f.status}) {marker}
            </Text>
          );
        })}
      </Box>
      {currentHunk && currentFile ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          <Text dimColor>{currentHunk.header}</Text>
          {currentHunk.lines.map((line, i) => (
            <Text
              key={i}
              color={line.type === "add" ? "green" : line.type === "remove" ? "red" : undefined}
            >
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              {line.content}
            </Text>
          ))}
          <Text bold color={decisions.get(currentHunk.id) === "approved" ? "green" : decisions.get(currentHunk.id) === "rejected" ? "red" : "yellow"}>
            [{decisions.get(currentHunk.id) ?? "undecided"}]
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>a: approve  r: reject  ↑/↓: navigate  Enter: submit  Esc: cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Confirm it compiles**

Run: `bun x tsc --noEmit` from repo root.
Expected: no new errors attributable to `canvas/src/canvases/diff.tsx` or `canvas/src/canvases/diff/*`.

- [ ] **Step 3: Commit**

```bash
git add canvas/src/canvases/diff.tsx
git commit -m "feat(diff): Diff canvas component"
```

---

### Task 3: Scenario registration and CLI wiring

**Files:**
- Create: `canvas/src/scenarios/diff/review.ts`
- Modify: `canvas/src/scenarios/registry.ts`
- Modify: `canvas/src/scenarios/index.ts`
- Modify: `canvas/src/canvases/index.tsx`
- Modify: `canvas/src/cli.ts`

**Interfaces:**
- Consumes: `ScenarioDefinition` type (existing, `canvas/src/scenarios/types.ts`); `Diff` component (Task 2).
- Produces: `diffReviewScenario: ScenarioDefinition`; `"diff"` becomes a valid `renderCanvas` kind and a valid `KNOWN_KINDS` entry.

- [ ] **Step 1: Write the scenario definition**

`canvas/src/scenarios/diff/review.ts`:

```ts
import type { ScenarioDefinition } from "../types";

export const diffReviewScenario: ScenarioDefinition = {
  name: "review",
  description: "Review a multi-file unified diff hunk by hunk",
  canvasKind: "diff",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
```

- [ ] **Step 2: Register it**

In `canvas/src/scenarios/registry.ts`, add near the `flight:booking` registration:

```ts
import { diffReviewScenario } from "./diff/review";
// ...
registry.set("diff:review", diffReviewScenario);
```

In `canvas/src/scenarios/index.ts`, add:

```ts
export * from "./diff/review";
```

- [ ] **Step 3: Wire the render dispatcher**

In `canvas/src/canvases/index.tsx`, import `Diff` and `DiffProps`/config type, add a `case "diff":` branch to the switch inside `renderCanvas` mirroring the existing `case "flight":` branch's shape (render, pass `id`/`config`/`scenario`/`enabled`, await `waitUntilExit()`).

- [ ] **Step 4: Add to KNOWN_KINDS**

In `canvas/src/cli.ts`, find `KNOWN_KINDS` (a `Set<string>` or array containing `"calendar", "document", "flight"`) and add `"diff"`.

- [ ] **Step 5: Verify the scenario is discoverable**

Write this test in `canvas/src/scenarios/registry.test.ts` (existing file — add to it, do not replace it):

```ts
test("diff:review is registered", () => {
  expect(getScenario("diff", "review")).toBeDefined();
});
```

Run: `bun test canvas/src/scenarios/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the whole suite and typecheck are still clean**

Run: `bun x tsc --noEmit` from repo root — expect 0 errors.
Run: `bun test` from repo root — expect all prior tests still passing, plus the new one.

- [ ] **Step 7: Commit**

```bash
git add canvas/src/scenarios/diff canvas/src/scenarios/registry.ts canvas/src/scenarios/index.ts canvas/src/scenarios/registry.test.ts canvas/src/canvases/index.tsx canvas/src/cli.ts
git commit -m "feat(diff): register diff:review scenario and wire CLI/render dispatch"
```

---

### Task 4: Render snapshot tests

**Files:**
- Create: `canvas/test/snapshots/diff.test.tsx`

**Interfaces:**
- Consumes: `renderCanvas` test harness helper (`canvas/test/harness/render.tsx`, Phase 1); `Diff` component (Task 2).

- [ ] **Step 1: Write the snapshot tests**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";

const SAMPLE_DIFF = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old a
+new a
 shared
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-old b
+new b
`;

test("diff canvas renders a multi-file diff", async () => {
  const r = renderCanvas(
    <Diff id="diff-1" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("diff canvas renders an empty-diff state", async () => {
  const r = renderCanvas(
    <Diff id="diff-2" config={{ title: "Review", diffText: "" }} scenario="review" enabled={false} />,
    { columns: 80, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("diff canvas renders a parse error state", async () => {
  const r = renderCanvas(
    <Diff id="diff-3" config={{ title: "Review", diffText: "not a diff" }} scenario="review" enabled={false} />,
    { columns: 80, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("diff canvas is deterministic across renders", async () => {
  const a = renderCanvas(
    <Diff id="diff-4" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(
    <Diff id="diff-4" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
```

- [ ] **Step 2: Run and confirm snapshots are written, then re-run to confirm stability**

Run: `bun test canvas/test/snapshots/diff.test.tsx` (from repo root) twice.
Expected: first run PASS and writes `.snap`; second run PASS with no rewrite.

- [ ] **Step 3: Commit**

```bash
git add canvas/test/snapshots/diff.test.tsx canvas/test/snapshots/__snapshots__/diff.test.tsx.snap
git commit -m "test(diff): render snapshots"
```

---

### Task 5: Real-socket IPC integration test

**Files:**
- Create: `canvas/test/integration/diff.test.tsx`

**Interfaces:**
- Consumes: `Diff` component (Task 2); `renderCanvas` harness (Phase 1); `readRecord`, `deleteRecord` (`canvas/src/runtime/registry.ts`, Phase 1); `openConnection` (`canvas/src/runtime/client.ts`, Phase 1).

This test proves the canvas is correctly wired to real IPC — not just that it renders. It spawns the component with `enabled: true` (a real server starts and a real registry record is written), connects a real TCP client exactly as a controller would, and drives the UI via simulated keypresses to confirm the eventual `selected` message matches what the user "did".

- [ ] **Step 1: Write the test**

```tsx
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";
import { deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const ONE_HUNK_DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-old
+new
`;

test("approving the only hunk and submitting sends the right result over a real socket", async () => {
  const id = "diff-it-1";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  // Wait for the server to start and the registry record to be written.
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  // Simulate the user: approve the hunk, then press Enter to submit.
  r.stdin.write("a");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "approved" }] },
  });

  conn.close();
  r.dispose();
});

test("submitting without deciding a hunk reports it as rejected", async () => {
  const id = "diff-it-2";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\r"); // submit immediately, no decision made
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({
    type: "selected",
    data: { decisions: [{ hunkId: "a.txt#0", decision: "rejected" }] },
  });

  conn.close();
  r.dispose();
});

test("escape cancels without sending a result", async () => {
  const id = "diff-it-3";
  ids.push(id);
  const r = renderCanvas(
    <Diff id={id} config={{ diffText: ONE_HUNK_DIFF }} scenario="review" enabled={true} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));

  const conn = await openConnection(id);

  r.stdin.write("\x1b"); // Esc
  await r.settle();

  const msg = await conn.next(2000);
  expect(msg).toEqual({ type: "cancelled", reason: "escape" });

  conn.close();
  r.dispose();
});
```

If the test harness's `renderCanvas` return type does not currently expose a `stdin` handle for writing simulated key input, add one: check `canvas/test/harness/render.tsx`'s `TestStdin` class (already defined there per Phase 1) and export the instance used for a given render as `stdin` on the returned object, alongside the existing `frame`/`settle`/`dispose`. This is a small, additive change to the harness — do not alter its existing exported shape for any other field.

- [ ] **Step 2: Run test to verify it fails (or reveals the harness gap)**

Run: `bun test canvas/test/integration/diff.test.tsx` from repo root.
Expected: FAIL initially — either the module doesn't exist yet, or (if the harness lacks a `stdin` export) a clear TypeScript error naming the missing property. Fix the harness gap first if needed, following the constraint above, before proceeding.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test canvas/test/integration/diff.test.tsx` from repo root.
Expected: PASS, 3 tests.

- [ ] **Step 4: Run the full suite**

Run: `bun test` from repo root.
Expected: PASS, all prior tests plus these new ones, zero snapshot diffs.
Run: `bun x tsc --noEmit` from repo root.
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add canvas/test/integration/diff.test.tsx canvas/test/harness/render.tsx
git commit -m "test(diff): real-socket IPC integration tests"
```

## Self-Review

**Spec coverage:** Data model (Task 1), parser with all named edge cases (Task 1), interaction model incl. explicit submit vs. cancel (Task 2), scenario registration + `KNOWN_KINDS` (Task 3), error handling for empty/unparseable/binary input (Task 2, tested Task 4), all three testing layers named in the spec — parser units, render snapshots, IPC integration (Tasks 1, 4, 5). No spec requirement for this primitive is unassigned.

**Placeholder scan:** The parser's `header:` field construction in Task 1 Step 3 was flagged inline as needing a real fix rather than the placeholder expression shown — the step's own text gives the exact corrective instruction (capture `headerLine` before advancing `i`) rather than leaving it as "TODO". No other placeholders found.

**Type consistency:** `DiffReviewConfig`/`DiffReviewResult`/`HunkDecision` (Task 1) are used identically in the component (Task 2), the scenario (Task 3), and both test files (Tasks 4-5). The component is named `Diff` everywhere it is imported. `parseUnifiedDiff`/`DiffParseError` names match between their definition (Task 1) and their only consumer (Task 2).
