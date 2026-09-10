# Canvas Plugin

Interactive terminal TUI components for Claude Code.

## Overview

Canvas provides spawnable terminal displays -- four generic primitives (`picker`, `form`, `table`, `diff`) plus domain canvases (`calendar`, `document`, `flight`, `image`) -- with real-time IPC communication. Claude can spawn these TUIs in a tmux split pane or a Windows Terminal pane and receive user selections.

## Canvas Types

| Type | Description |
|------|-------------|
| `calendar` | Display events, pick meeting times |
| `document` | View/edit markdown documents |
| `flight` | Compare flights and select seats |
| `image` | Show a PNG in a pane, scaled to fit -- view-only |
| `diff` | Review a unified diff hunk-by-hunk |
| `picker` | Choose one or more options from a list |
| `form` | Fill in structured fields and submit them as one result |
| `table` | Display tabular data, view-only |
| `dashboard` | Several of the above composed into one pane |

## Installation

```bash
# Add as Claude Code plugin
claude --plugin-dir /path/to/claude-canvas/canvas

# Or via marketplace. The plugin id is <plugin>@<marketplace>, and this
# repository's marketplace is named "claude-canvas" with one plugin,
# "canvas" (see .claude-plugin/marketplace.json).
/plugin marketplace add <owner>/claude-canvas
/plugin install canvas@claude-canvas
```

## Two entry points

- **`dist/cli.js`** — the shipped bundle, and what the skills tell Claude to
  run. Built by `bun run build` from the repository root, committed, and
  checked by CI. It has no runtime dependencies at all, which is what lets an
  installed plugin work with no `bun install` step: a plugin arrives as a git
  clone with no `node_modules`, so anything importing `ink` at runtime could
  not render.
- **`src/cli.ts`** — the source, and what to run while developing. Needs
  `bun install` at the repository root.

Rebuild after changing anything under `src/`, or CI fails on a stale bundle.

## Usage

```bash
# Show calendar in current terminal
bun run src/cli.ts show calendar

# Spawn meeting picker in a new pane
bun run src/cli.ts spawn calendar --scenario meeting-picker --config '{"calendars": [...]}'

# Spawn document editor
bun run src/cli.ts spawn document --scenario edit --config '{"content": "# Hello"}'

# Block for the user's selection (returns within ~55s no matter what)
bun run src/cli.ts wait cal-1

# Discover what scenarios exist, and whether each returns a result
bun run src/cli.ts scenarios
bun run src/cli.ts scenarios diff
```

Every command prints one JSON object on stdout. `wait` returns one of
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

## Commands

- `/canvas` - Interactive canvas spawning

## CLI verbs

| Verb | Purpose |
|---|---|
| `show <kind>` | Render in the current terminal |
| `spawn <kind>` | Open in a split pane; waits until the canvas is reachable |
| `wait <id>` | Block for the outcome; reads a persisted one if the canvas already exited |
| `update <id>` | Push a new config into a running canvas |
| `get <id> <key>` | Read canvas state (only `document` answers keys today) |
| `close <id>` | Ask the canvas to exit |
| `list` | Live canvases |
| `scenarios [kind]` | Available scenarios and their interaction modes |
| `env` | Detected host and terminal capabilities |

## Skills

- `canvas` - Main skill with overview and IPC details
- `calendar` - Calendar display and meeting picker
- `document` - Markdown rendering and text selection
- `flight` - Flight comparison and seatmaps
- `image` - Show a PNG in a pane, scaled to fit
- `diff` - Diff review, per-hunk approve/reject
- `picker` - Single/multi-select option picker
- `form` - Structured fields with validation
- `table` - Tabular display, view-only
- `dashboard` - Several views in one pane, with a region-tagged outcome

## Requirements

- **tmux 3.1+ or Windows Terminal** - Canvas spawning requires one of these two host backends
- **Bun** - Runtime for CLI commands
- **Terminal with mouse support** - For interactive scenarios

## License

MIT
