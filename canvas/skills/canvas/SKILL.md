---
name: canvas
description: |
  **Start here for terminal canvases** — interactive panes Claude opens beside the conversation and reads answers back from.
  Reach for one whenever the next step depends on something the user has to choose, review, fill in, or read:
  picking a file, branch, test or option; approving parts of a diff hunk by hunk; answering several related
  questions at once; reading a table of results; seeing project state at a glance; or picking a meeting time.
  Prefer a canvas over asking in prose whenever the choice is already enumerable — it returns an exact id or a
  typed value instead of free text to interpret. Covers spawning, the CLI verbs, live updates, and how outcomes
  come back. Requires tmux or Windows Terminal to open a pane.
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
| `dashboard` | Several of the above composed into one pane | `display` |

## Quick Start

```bash
cd ${CLAUDE_PLUGIN_ROOT}

# Run canvas in current terminal
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js show calendar

# Spawn canvas in a new pane
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar --scenario meeting-picker --config '{...}'
```

## Spawning Canvases

**Always use `spawn` for interactive scenarios** - this opens the canvas in a split pane (tmux or Windows Terminal) while keeping the conversation terminal available.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn [kind] --scenario [name] --config '[json]'
```

**Parameters:**
- `kind`: Canvas type (calendar, document, flight, diff, picker, form, table, dashboard)
- `--scenario`: Interaction mode (e.g., display, meeting-picker, edit)
- `--config`: JSON configuration for the canvas
- `--id`: Optional canvas instance ID for IPC

## Interacting with a canvas

```bash
# Open a canvas beside the conversation
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar \
  --scenario meeting-picker --id cal-1 --config '{...}'

# Block for the user's choice. Returns within ~55s no matter what.
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait cal-1
```

Every command prints one JSON object. `wait` returns one of
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

`update <id> --config '<json>'` pushes a new config into a canvas that is
already open — refreshing a table's rows, or replacing a diff after you
regenerated it, without closing the pane. Use `--config-file` for anything
large. Note that the canvas **resets its interaction state** on an update:
a pushed config is a new question, so a half-filled form or a set of hunk
decisions from the previous diff is discarded rather than misapplied.

`scenarios [kind]` lists every scenario you can ask for, with its
`interactionMode`. Worth reading once rather than guessing: a
`view-only` scenario has **no `selected` outcome at all**, so its `wait`
ending in `{"status":"cancelled"}` is the successful end of its life, not a
failure. An unknown `--scenario` is now rejected outright, naming the real
ones, rather than silently rendering a different view.

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
| see several of those at once, or choose in context | `dashboard` |

Prefer a primitive over asking in prose whenever the choice is already
enumerable: the result comes back as an exact id or a typed value rather
than free text you have to interpret.

## Outcomes cannot be missed

You do not have to race the user. A canvas produces exactly one outcome, and
it is retained: written into its registry record before it is broadcast and
before the canvas exits. `wait` reads that record first, so all of these
work:

- The user chooses **before** you call `wait`. You still get the choice.
- The canvas has **already exited** by the time you call `wait`. You still
  get the outcome.
- The canvas reports a **config error**. You get
  `{"status":"error","message":"..."}` naming what was wrong, rather than a
  55 s `pending` that tells you nothing.

Two consequences worth knowing:

- **An outcome is delivered once.** Reading it consumes it, so a second
  `wait` on the same id answers `no canvas <id>`. Act on the first answer;
  do not re-poll for confirmation.
- **The first outcome wins.** If a canvas reports a config error and the
  user then presses Escape, you get the error, not the cancellation — the
  more informative of the two.

`spawn` also no longer reports success until the canvas is actually
reachable, so a `wait` issued immediately after it will not answer
`no canvas <id>` for a canvas that was merely still starting.

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
| `dashboard` | Several views in one pane, with a region-tagged outcome |
