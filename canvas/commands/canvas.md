---
name: canvas-legacy
description: Spawn interactive terminal canvases for calendars, documents, flight booking, diff review, option pickers, forms, tables, images, and dashboards
---

# Canvas Command

Spawn and control interactive terminal displays (TUIs) in split panes, using
tmux or Windows Terminal, whichever is available.

## Usage

When the user invokes `/canvas`, help them spawn the appropriate canvas type based on their needs.

## Workflow

### Step 1: Determine Canvas Type

Ask what kind of canvas the user needs:

- **Calendar** - Display events or pick meeting times
- **Document** - View or edit markdown content
- **Flight** - Compare flights and select seats
- **Diff** - Review a unified diff hunk-by-hunk
- **Picker** - Choose one or more options from a list
- **Form** - Fill in structured fields and submit them as one result
- **Table** - Display tabular data, view-only
- **Dashboard** - Several of the above in one pane, at a glance

If you are unsure which scenario a kind supports, ask the CLI rather than
guessing -- an unknown `--scenario` is rejected:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js scenarios <kind>
```

A scenario reported as `"interactionMode": "view-only"` has no `selected`
outcome; its `wait` ends in `cancelled` by design.

### Step 2: Gather Configuration

Based on the canvas type, collect the necessary configuration:

**Calendar:**
- Events to display (title, start/end times)
- For meeting picker: multiple calendars with busy times
- Slot granularity (15/30/60 minutes)

**Document:**
- Markdown content to display
- Document title
- Edit mode or display-only
- Optional diff highlighting

**Flight:**
- Flight options (airline, times, prices)
- Seatmap configuration
- Origin/destination airports

**Diff:**
- Unified diff text to review (`diff --git` or plain `diff -u` style)
- Optional title

**Picker:**
- Options to choose from (id + label, optional description/disabled)
- Single- or multi-select mode (`mode` is required)
- Optional title/prompt

**Form:**
- Fields: `text`, `textarea`, `select`, `checkbox`, `number`
- Which fields are `required` (checkbox never is)
- `min`/`max` for number fields

**Table:**
- Columns (key + label, optional width)
- Rows as objects of string values
- Optional title

**Dashboard:**
- Which regions, and of what kind (`text`, `table`, `tree`, `picker`,
  `form`, `diff`)
- Each region's own config, plus an optional fixed `rows` height
- Note that YOU gather the data (git status, test output, file tree); the
  canvas only renders the config you build

### Step 3: Spawn Canvas

Use the CLI to spawn the canvas:

```bash
cd ${CLAUDE_PLUGIN_ROOT}
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn [type] --scenario [scenario] --config '[json]'
```

**Examples:**

```bash
# Calendar display
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar --config '{"events": [...]}'

# Meeting picker
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar --scenario meeting-picker --config '{"calendars": [...]}'

# Document editor
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn document --scenario edit --config '{"content": "# Title", "title": "Doc"}'

# Flight booking
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn flight --config '{"flights": [...]}'

# Diff review
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn diff --config '{"diffText": "diff --git a/... "}'

# Option picker
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn picker --config '{"mode": "single", "options": [...]}'

# Structured form
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn form --config '{"fields": [...]}'

# Tabular display (view-only: closes with cancelled, never selected)
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn table --config '{"columns": [...], "rows": [...]}'

# A PNG, scaled to the pane (view-only)
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn image --config '{"path": "media/screenshot.png"}'
```

### Step 3b: Update a canvas in place (optional)

To change what an open canvas shows without closing it:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js update cal-1 --config '{...}'
```

The canvas resets its interaction state on an update -- a pushed config is a
new question, so a half-filled form or a previous diff's decisions are
discarded rather than misapplied.

### Step 4: Handle Results

Use `wait <id>` to block for the user's interaction (returns within ~55s no
matter what — call it again if it comes back `pending`):

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait cal-1
```

`wait` prints one of:

- `{"status":"selected","data":...}` — user made a selection (time slot,
  text, flight+seat, diff hunk decisions, picker option ids)
- `{"status":"cancelled"}` — user pressed Escape or quit
- `{"status":"pending"}` — timed out, canvas still alive; call `wait` again
- `{"status":"disconnected"}` — canvas died while waiting
- `{"status":"error","message":...}` — something went wrong

For the `document` canvas specifically, selection is not delivered through
`wait` — poll it on demand with `get <id> selection` instead. Once done with
a canvas, close it with `close <id>` (never kill the process — see
`canvas` skill).

## Requirements

- Must be running inside a tmux session (tmux 3.1+) or Windows Terminal
- Terminal should support mouse input for interactive scenarios

## Skills Reference

Read these skills for detailed configuration options:

- `canvas` - Overview and IPC communication
- `calendar` - Calendar events and meeting picker
- `document` - Markdown rendering and text selection
- `flight` - Flight comparison and seatmaps
- `diff` - Diff review, per-hunk approve/reject
- `picker` - Option picker
- `form` - Structured fields with validation
- `table` - Tabular display, view-only
- `image` - PNG display, scaled to the pane, view-only
- `dashboard` - Several of the above composed in one pane
