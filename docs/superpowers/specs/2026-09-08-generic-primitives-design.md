# Generic Primitives — Design

**Phase 2 of the roadmap in [`docs/roadmap.md`](../../roadmap.md).**
Date: 2026-09-08.

## Problem

Every canvas today is a domain-specific demo — `calendar`, `document`,
`flight`. Each one hardcodes its own interaction logic even where that logic
is generic (choosing from a list, filling in fields, showing a table). There
is no reusable building block a future canvas, or Claude itself, can reach
for without writing another bespoke 600-line component.

Success for this phase, as scoped by the user: the project should be trivial
to install and try, Claude should reach for a canvas on its own initiative
rather than only when explicitly asked, the primitives should have real
depth (not toy demos), and the result should look and feel polished. Four
primitives cover the interaction shapes that recur constantly in working
with Claude Code: **picker** (choose from a list), **form** (fill in
structured fields), **table** (view tabular data), **diff** (review a code
change hunk by hunk).

## Scope note

These are four independent subsystems sharing only the Phase 1 foundation
(`useCanvasServer`, the scenario registry, the CLI, the render-snapshot
testing convention). Each gets its own types, its own scenario registration,
its own tests, and its own implementation task sequence. This document
specs all four because the user asked to finish Phase 2's design in one
pass; it does not mean crossing wires between them — a bug in `form` must
never be able to touch `table`'s code path.

## Success criteria

- Each primitive spawns via the existing CLI (`spawn <kind> --scenario
  <name> --config-file <path>`) with no changes to `runtime/`, `host/`, or
  the CLI's core commands beyond registering the four new kinds.
- Each primitive renders correctly with a byte-stable snapshot test, using
  the harness already built in Phase 1 (no new test infrastructure needed).
- `diff`'s parser recovers file/hunk/line structure from real `git diff`
  output (multi-file, added/deleted/renamed, no-trailing-newline, binary)
  well enough to drive correct per-hunk approve/reject.
- `picker` supports both single- and multi-select from one implementation.
- `form` supports five field types: single-line text, multi-line text,
  select, checkbox, number-with-range.
- `table` renders scrollable tabular data; it has no selection concept.
- No new runtime dependencies. This matches the convention held through
  every one of Phase 1's 18 tasks; the diff parser in particular is simple
  enough (a few regex patterns over a well-documented text format) not to
  justify breaking it.

## Non-goals

- **Composing these into a domain canvas** (kanban, PR reviewer, etc.) —
  Phase 3's job. These four ship as standalone, generic canvases.
- **Image/screenshot rendering** — Phase 3. The capability field already
  exists on `CanvasHost`; nothing here populates or consumes it.
- **Row selection inside `table`** — deliberately out of scope. If a future
  need arises to pick a row, compose `table`'s display with `picker`'s
  selection rather than duplicating selection logic inside `table`.
- **Field types beyond the five approved for `form`** — no date pickers,
  no file upload, no nested/repeating fields. Add if a real need appears;
  building them speculatively now is exactly what YAGNI exists to prevent.
- **Making Claude actually choose to open these unprompted.** That is a
  skill-doc / prompting concern for whichever future workflow consumes a
  primitive, not something a primitive's own runtime code can force. This
  spec ships primitives that work well when invoked; teaching Claude when
  to invoke one is out of scope here.

## Shared architecture

All four primitives plug into the unchanged Phase 1 system:

- `useCanvasServer` (from `runtime/use-canvas-server.ts`) is consumed as-is —
  no primitive needs a new IPC capability.
- Each registers one or more scenarios in `scenarios/registry.ts` under
  `<kind>:<scenario>`, following the exact pattern `flight:booking` already
  established.
- Each is invoked through the existing CLI verbs (`spawn`, `show`, `wait`,
  `get`, `close`) with no new commands.

**One integration point that is easy to forget and must not be:** the final
whole-branch review's Critical fix added a `KNOWN_KINDS` whitelist in
`cli.ts` (`{calendar, document, flight}`) specifically to stop an unknown
kind from reaching a pane and crashing it non-zero. **All four new kinds —
`picker`, `form`, `table`, `diff` — must be added to that set**, or spawning
any of them fails at the exact validation gate built to protect against
typos, rejecting a real, correctly-spelled kind as if it were one.

Every primitive follows the same test discipline as Phase 1: a render
snapshot (via the existing harness, `TZ=UTC`/`FORCE_COLOR` pin unaffected
since none of these primitives render a clock), an integration test
exercising the real IPC round trip (spawn → update/get → selected/cancelled
→ close) with no terminal involved, and unit tests for any non-trivial
parsing or validation logic.

---

## Primitive 1: Diff

Review a multi-file unified diff hunk by hunk, approving or rejecting each
one, so Claude can apply exactly the hunks the user accepted.

### Data model

```ts
interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;       // true => no hunks, not reviewable, shown as a label
  hunks: DiffHunk[];
}

interface DiffHunk {
  id: string;             // stable: `${file.newPath}#${index}`
  header: string;         // raw "@@ -l,s +l,s @@" text, shown verbatim
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNo?: number;      // present for "context" and "remove", absent for "add"
  newLineNo?: number;      // present for "context" and "add", absent for "remove"
}
```

### Config and result

```ts
interface DiffReviewConfig {
  title?: string;
  diffText: string;        // the complete unified diff, already generated by Claude
}

interface DiffReviewResult {
  decisions: Array<{ hunkId: string; decision: "approved" | "rejected" }>;
}
```

A hunk with no explicit decision when the user submits is recorded as
`"rejected"` — silence is not consent for something that changes real code.

### Parser

Input: the raw unified diff string, one or more files. Output: `DiffFile[]`.

1. Split into per-file blocks. Prefer the `diff --git a/... b/...` header;
   fall back to a bare `--- a/...` / `+++ b/...` pair when that header is
   absent (plain `diff -u` output has no git header).
2. Determine `status`: `--- /dev/null` → `added`; `+++ /dev/null` →
   `deleted`; a `rename from` / `rename to` pair → `renamed`; otherwise
   `modified`.
3. Extract hunks with `@@ -oldStart,oldLines +newStart,newLines @@`. The
   count is optional when it is 1 (`@@ -1 +1 @@` means length 1).
4. Classify each hunk line by its leading character (`+`, `-`, ` `),
   advancing `oldLineNo`/`newLineNo` counters that only increment for the
   side each line type touches (context advances both, add only the new
   side, remove only the old side).

**Must not crash the parser:** a `\ No newline at end of file` marker; a
binary-file block (`Binary files a/x and b/x differ`, no hunks — recorded
with `binary: true`, shown as a label, contributes no hunks to review);
genuinely malformed input, which must surface as a reported parse error
(`sendError`), never a garbled render or a thrown exception inside the TUI.

### Interaction

Two zones: a file list (each row shows added/removed line counts and how
many of its hunks are still undecided) and the current file's hunks below
it, navigated with the arrow keys or `j`/`k` (crossing a file boundary moves
to the next file's first hunk). Each hunk shows one of three states —
undecided, approved, rejected — with a visual marker (`✓`/`✗`/`—`), and a
decision can be revisited and changed any time before submission.

Closing is explicit, not implicit: a dedicated submit action sends
`DiffReviewResult` via `sendSelected` and closes; `Esc` sends `sendCancelled`
and applies nothing. These are deliberately distinct outcomes, since an
accidental close must never be mistaken for a completed review.

### Error handling

- Empty or whitespace-only `diffText` → a clear in-TUI message ("nothing to
  review"), never an empty hunk view.
- Unparseable text → `sendError`, canvas does not enter a half-initialized
  state.
- A binary file inside an otherwise-normal diff does not block reviewing
  the rest of the files.

### Testing

- Parser unit tests against real `git diff` output (not hand-authored
  fixtures) covering: multi-file, added/deleted/renamed, no trailing
  newline, binary file. This is the closest thing to security-relevant code
  in this primitive — a misparsed hunk means an "approved" decision maps to
  the wrong lines.
- Render snapshot of the file-list-plus-hunk view via the existing harness.
- Integration test: spawn, submit a mix of approved/rejected hunks
  including one left undecided, confirm the undecided hunk arrives as
  `"rejected"`.

---

## Primitive 2: Picker

Choose one or more options from a list — the generic form of what
`calendar`'s meeting-picker already does for times, decoupled from any
calendar-specific concept.

### Data model

```ts
interface PickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface PickerConfig {
  title?: string;
  prompt?: string;
  mode: "single" | "multi";
  options: PickerOption[];
}

interface PickerResult {
  selectedIds: string[];   // exactly one entry when mode is "single"
}
```

### Interaction

Arrow keys or `j`/`k` move the highlighted option. In `single` mode,
`Enter` selects the highlighted option and submits immediately. In `multi`
mode, `Space` toggles the highlighted option's checked state and `Enter`
submits whatever is checked. `Esc` cancels in either mode. A `disabled`
option is visible but cannot be highlighted onto or selected.

### Error handling

An empty `options` array is a config error, not a canvas that opens and
hangs — reported via `sendError` before any render.

### Testing

- Render snapshot for both `single` and `multi` mode, including at least
  one `disabled` option.
- Result-shape test: `single` mode always yields exactly one id;
  `multi` mode yields the exact set toggled on, in no particular order
  requirement.
- Empty-options rejection test.

---

## Primitive 3: Form

Fill in a small set of structured fields and submit them as one result.

### Data model

```ts
type FormField =
  | { id: string; type: "text"; label: string; placeholder?: string; required?: boolean }
  | { id: string; type: "textarea"; label: string; placeholder?: string; required?: boolean }
  | { id: string; type: "select"; label: string; options: Array<{ value: string; label: string }>; required?: boolean }
  | { id: string; type: "checkbox"; label: string }
  | { id: string; type: "number"; label: string; min?: number; max?: number; required?: boolean };

interface FormConfig {
  title?: string;
  fields: FormField[];
}

interface FormResult {
  values: Record<string, string | number | boolean>;
}
```

`checkbox` has no `required` variant — an unchecked box is a valid, meaningful
`false`, never a missing value.

### Interaction

`Tab` / `Shift+Tab` move between fields regardless of field type — including
inside `textarea`, where typed `Enter` inserts a newline in the field's own
content rather than moving focus, so `Tab` is the only way to leave a
multi-line field. `checkbox` toggles on `Space`. `select` cycles its options
with the left/right arrows or opens/closes on `Enter`. `number` accepts
digit input only and clamps to `min`/`max` when the field loses focus, not
on every keystroke (so a user can type "1" on the way to "12" without it
being clamped mid-entry).

### Validation

Submitting with a `required` field still empty does not close the canvas —
it highlights every missing required field in place and keeps the form
open. This is a hard rule: a form primitive that can silently submit
incomplete required data is worse than one that refuses to.

### Error handling

A `select` field with an empty `options` array is a config error
(`sendError`), the same posture as `picker`'s empty-list case, since a
`select` is structurally a picker embedded in a field.

### Testing

- Render snapshot covering all five field types in one form, including a
  `select` mid-cycle and a `checkbox` in both states.
- Validation test: submit with a required field empty, confirm the canvas
  stays open and reports which field(s) are missing; submit with all
  required fields filled, confirm `sendSelected` fires with the right
  `FormResult` shape per field type (`checkbox` → boolean, `number` →
  number, the rest → string).
- Clamp test: a `number` field's out-of-range value is clamped on blur, not
  mid-keystroke.

---

## Primitive 4: Table

Display tabular data with good formatting and scrolling. View-only by
design — no selection concept lives inside this primitive.

### Data model

```ts
interface TableColumn {
  key: string;
  label: string;
  width?: number;    // characters; overflowing content is truncated with an ellipsis
}

interface TableConfig {
  title?: string;
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
}
```

No result type. `table` uses `interactionMode: "view-only"`, mirroring
`document`'s existing `display` scenario precedent: the user looks, then
closes. Closing always sends `sendCancelled` — there is no "selected"
outcome for this primitive, by the design decision already made that row
selection composes with `picker` rather than living here.

### Interaction

A fixed header row stays visible while the body scrolls (arrow keys or
`PageUp`/`PageDown`). A column with no explicit `width` sizes to the
longest value actually present in that column, capped at 40 characters;
content beyond a column's effective width (explicit or capped-auto) is
truncated with an ellipsis, never wrapped (wrapping would break row
alignment).

### Error handling

Zero rows renders an explicit "no data" state distinguishable from a blank
screen — an empty table must never look like a bug.

### Testing

- Render snapshot with a representative fixture: several rows, several
  columns, at least one cell long enough to force truncation.
- Scroll test: confirm the header stays put while the body's visible
  window moves.
- Empty-rows test: confirm the explicit "no data" state renders rather than
  a blank frame.

---

## Cross-cutting work, once, not per primitive

- Extend `cli.ts`'s `KNOWN_KINDS` with all four new kinds.
- Register all scenarios in `scenarios/registry.ts`
  (`picker:select`, `form:fill`, `table:display`, `diff:review` — names
  chosen for clarity; the implementation plan may adjust exact scenario
  names as long as they stay descriptive).
- Add a `skills/<kind>/SKILL.md` per primitive, following the exact
  structure Task 17 already established for the Phase 1 canvases (overview,
  example prompts, CLI usage, config shape).
