# Claude Canvas

A TUI toolkit that gives Claude Code its own display. Claude opens an
interactive pane beside the conversation, you act in it, and your answer
comes back to Claude.

![Claude Canvas Screenshot](media/screenshot.png)

The point is that some answers are much cheaper to give than to type. Picking
one of eight files, approving three hunks of a diff and refusing the fourth,
filling in five related fields — all of it is faster in a pane, and it comes
back to Claude as an exact value instead of prose it has to interpret.

## What you get

Four generic primitives, a composed canvas, and three domain demos:

| Canvas | What it is for |
|---|---|
| `picker` | Choose one or more options from a list |
| `form` | Fill in structured fields and submit them together |
| `table` | Read tabular data, with a fixed header and scrolling body |
| `diff` | Review a unified diff hunk by hunk, approving or rejecting each |
| `dashboard` | Several of the above in one pane, at a glance |
| `calendar` | Display events, or pick a meeting time from several calendars |
| `document` | View or edit markdown, with text selection |
| `flight` | Compare flights and pick a seat (a demo of the machinery) |

## Requirements

- **[Bun](https://bun.sh)** — the runtime the canvases run on
- **[tmux](https://github.com/tmux/tmux) 3.1+ or Windows Terminal** — a canvas
  opens in a split pane, so one of these has to be hosting your shell.
  `spawn` refuses with a clear message if neither is; `show` still works
  without one.

## Install

```
/plugin marketplace add sgomez-dev/claude-canvas
/plugin install canvas@claude-canvas
```

Or from a clone, without a marketplace:

```
/plugin marketplace add /path/to/claude-canvas
/plugin install canvas@claude-canvas
```

## Try it in one minute

Canvases open in a tmux split, so **start tmux first** — this is the step
that catches everyone:

```bash
tmux
```

Then ask Claude for something whose answer is a choice:

- "Show me the failing tests in a table"
- "Which of these files should I refactor? Let me pick"
- "Show me the diff before you apply it, hunk by hunk"
- "Give me a dashboard of this repo: branch, test results, changed files"
- "Find a time next week when Alice and Bob are both free"

A pane opens on the right, you act, and Claude carries on with your answer.

You can also drive it by hand, which is the fastest way to see it work:

```bash
cd /path/to/claude-canvas
bun install

# Open a picker in a split pane, then block for the answer
bun run canvas/src/cli.ts spawn picker --id demo \
  --config '{"title":"Pick one","mode":"single","options":[
    {"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}]}'
bun run canvas/src/cli.ts wait demo
```

`wait` prints one JSON object: `{"status":"selected","data":{"selectedIds":["b"]}}`.

To see every kind driven end to end, including a live update, run the smoke
script from inside tmux:

```bash
bash canvas/scripts/smoke.sh
```

## CLI verbs

| Verb | Purpose |
|---|---|
| `show <kind>` | Render in the current terminal |
| `spawn <kind>` | Open in a split pane; waits until the canvas is reachable |
| `wait <id>` | Block for the outcome; reads a persisted one if the canvas already exited |
| `update <id>` | Push a new config into a running canvas |
| `get <id> <key>` | Read canvas state |
| `close <id>` | Ask the canvas to exit |
| `list` | Live canvases |
| `scenarios [kind]` | Available scenarios and their interaction modes |
| `env` | Detected host and terminal capabilities |

## Project status

A fork of [dvdsgl/claude-canvas](https://github.com/dvdsgl/claude-canvas),
which was an explicitly unsupported proof of concept.

- **Phase 1 — foundations:** complete. One IPC (length-prefixed frames over
  loopback TCP with a token), cross-platform hosts (tmux and Windows
  Terminal), and CI on Linux, macOS and Windows.
- **Phase 2 — generic primitives:** complete. `picker`, `form`, `table`,
  `diff`.
- **Phase 3 — richer canvases:** in progress. `dashboard` and `tree` are
  done; image rendering is next.
- **Phase 4 — publishing:** not started.

The reasoning behind every decision, and every known gap, lives in
[`docs/roadmap.md`](docs/roadmap.md) and the ledgers under
[`docs/superpowers/`](docs/superpowers/).

## License

MIT
