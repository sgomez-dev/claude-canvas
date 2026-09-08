---
name: canvas
description: |
  **The primary skill for terminal TUI components.** Covers spawning, controlling, and interacting with terminal canvases.
  Use when displaying calendars, documents, or flight bookings.
---

# Canvas TUI Toolkit

**Start here when using terminal canvases.** This skill covers the overall workflow, canvas types, and IPC communication.

## Example Prompts

Try asking Claude things like:

**Calendar:**
- "Schedule a meeting with the team next week"
- "Find a time when Alice and Bob are both free"

**Document:**
- "Draft an email to the sales team about the new feature"
- "Help me edit this document — let me select what to change"

**Flight:**
- "Find flights from SFO to Denver next Friday"
- "Book me a window seat on the morning flight"

## Overview

Canvas provides interactive terminal displays (TUIs) that Claude can spawn and control. Each canvas type supports multiple scenarios for different interaction modes.

## Available Canvas Types

| Canvas | Purpose | Scenarios |
|--------|---------|-----------|
| `calendar` | Display calendars, pick meeting times | `display`, `meeting-picker` |
| `document` | View/edit markdown documents | `display`, `edit`, `email-preview` |
| `flight` | Flight comparison and seat selection | `booking` |
| `diff` | Review a unified diff hunk-by-hunk | `review` |
| `picker` | Choose one or more options from a list | `select` |
| `form` | Fill in structured fields and submit them as one result | `fill` |
| `table` | Display tabular data, view-only | `display` |

## Quick Start

```bash
cd ${CLAUDE_PLUGIN_ROOT}

# Run canvas in current terminal
bun run src/cli.ts show calendar

# Spawn canvas in a new pane
bun run src/cli.ts spawn calendar --scenario meeting-picker --config '{...}'
```

## Spawning Canvases

**Always use `spawn` for interactive scenarios** - this opens the canvas in a split pane (tmux or Windows Terminal) while keeping the conversation terminal available.

```bash
bun run src/cli.ts spawn [kind] --scenario [name] --config '[json]'
```

**Parameters:**
- `kind`: Canvas type (calendar, document, flight, diff, picker, form, table)
- `--scenario`: Interaction mode (e.g., display, meeting-picker, edit)
- `--config`: JSON configuration for the canvas
- `--id`: Optional canvas instance ID for IPC

## Interacting with a canvas

```bash
# Open a canvas beside the conversation
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn calendar \
  --scenario meeting-picker --id cal-1 --config '{...}'

# Block for the user's choice. Returns within ~55s no matter what.
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts wait cal-1
```

Every command prints one JSON object. `wait` returns one of
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

`get <id> <key>` reads state. Only `document` currently implements `onGet`
and answers `selection`, `content`, and `config`; `flight` and `calendar`
return `{"status":"ok","data":null}` for any key today.
`close <id>` asks the canvas to exit; `list` shows live canvases.

## Which canvas to reach for

The four generic primitives cover most real interactions; the three
domain canvases are demos of the same machinery.

| You need the user to... | Use |
|---|---|
| choose between things you can enumerate | `picker` |
| accept or refuse parts of a code change | `diff` |
| give several related answers at once | `form` |
| read a set of rows | `table` |

Prefer a primitive over asking in prose whenever the choice is already
enumerable: the result comes back as an exact id or a typed value rather
than free text you have to interpret.

## Known gap: outcomes are not buffered

A canvas sends its outcome (`selected`, `cancelled`, `error`) by
broadcasting to **whoever is connected at that instant**. Nothing is
retained, so:

- If the user acts before your `wait` connects, the outcome is broadcast to
  zero connections and lost. The canvas then exits and its registry record
  is removed, so the follow-up `wait` answers
  `{"status":"error","message":"no canvas <id>"}` and there is no way to
  recover what the user chose.
- A **config error** is effectively never observable. The primitives send it
  as soon as their own server is up, which is before any controller can have
  read the port from the registry record. The message is rendered in the
  pane, so a human sees it; you do not.
- `spawn` returns as soon as the pane is opened, which can be before the
  canvas has written its registry record — so a `wait` issued immediately
  after `spawn` can also answer `no canvas <id>`.

Until this is fixed, in practice:

1. **Validate configs before spawning.** A malformed config costs a 55 s
   `wait` that answers `pending` and tells you nothing.
2. **Call `wait` promptly** after `spawn`, and if it answers
   `{"status":"error","message":"no canvas <id>"}` immediately, retry once
   before concluding the canvas is gone.

## Requirements

- **tmux 3.1+ or Windows Terminal**: Canvas spawning requires one of these two host backends
- **Terminal with mouse support**: For click-based interactions
- **Bun**: Runtime for executing canvas commands

## Skills Reference

| Skill | Purpose |
|-------|---------|
| `calendar` | Calendar display and meeting picker details |
| `document` | Document rendering and text selection |
| `flight` | Flight comparison and seat map details |
| `diff` | Diff review, per-hunk approve/reject |
| `picker` | Single/multi-select option picker |
| `form` | Structured fields with validation |
| `table` | Tabular display, view-only |
