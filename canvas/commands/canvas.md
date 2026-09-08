---
name: canvas
description: Spawn interactive terminal canvases for calendars, documents, flight booking, diff review, and option pickers
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
- Single- or multi-select mode
- Optional title/prompt

### Step 3: Spawn Canvas

Use the CLI to spawn the canvas:

```bash
cd ${CLAUDE_PLUGIN_ROOT}
bun run src/cli.ts spawn [type] --scenario [scenario] --config '[json]'
```

**Examples:**

```bash
# Calendar display
bun run src/cli.ts spawn calendar --config '{"events": [...]}'

# Meeting picker
bun run src/cli.ts spawn calendar --scenario meeting-picker --config '{"calendars": [...]}'

# Document editor
bun run src/cli.ts spawn document --scenario edit --config '{"content": "# Title", "title": "Doc"}'

# Flight booking
bun run src/cli.ts spawn flight --config '{"flights": [...]}'

# Diff review
bun run src/cli.ts spawn diff --config '{"diffText": "diff --git a/... "}'

# Option picker
bun run src/cli.ts spawn picker --config '{"mode": "single", "options": [...]}'
```

### Step 4: Handle Results

Use `wait <id>` to block for the user's interaction (returns within ~55s no
matter what — call it again if it comes back `pending`):

```bash
bun run src/cli.ts wait cal-1
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
- `diff` - Diff review (coming soon)
- `picker` - Option picker (coming soon)
