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

- **[Bun](https://bun.sh)** — the runtime the canvases run on. The plugin
  ships a prebuilt bundle with no dependencies of its own, so there is no
  `bun install` step after installing it
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

## Credits

The idea, and the proof of concept that showed it worked, are
[David Siegel](https://github.com/dvdsgl)'s:
**[dvdsgl/claude-canvas](https://github.com/dvdsgl/claude-canvas)**. Giving
Claude Code a display of its own — a pane it opens, that a person acts in,
whose answer comes back as a value — is the creative leap here, and it was
his. The IPC-over-a-socket shape, the tmux split, the Ink canvases and the
scenario idea all come from that repository, and this one still renders his
`calendar`, `document` and `flight` canvases.

He published it as an explicitly unsupported proof of concept. This fork
takes it up from there.

## What this fork adds

Roughly, the original proved the idea and this took it to something that
holds up in daily use. Concretely, and in the order it happened:

**Foundations.** The original had two incompatible IPC layers, and the one
the docs described only worked for `document` — in `calendar` and `flight` a
user's selection reached nobody, because the canvas waited for a server the
CLI never started. That is now one transport: length-prefixed frames over
loopback TCP with a per-canvas token, which also made the whole thing
testable without a terminal. Along the way: a command injection in the
spawn path closed, Windows support (Windows Terminal as a host, no `/tmp`,
no bash shebangs), 113 typecheck errors fixed, and a test suite and 3-OS CI
built from nothing — there were no tests and no CI at all.

**Generic primitives.** The original's three canvases were demos with
hardcoded data. The reusable shapes underneath them are now their own
canvases: `picker`, `form`, `table` and `diff`.

**Composition.** Each primitive is a view, a canvas shell and a validator,
so a canvas can be built out of them instead of another 600 bespoke lines.
`dashboard` is the first: several views in one pane, with an outcome that
says which region answered.

**Reliability, mostly invisible.** Frames larger than the socket buffer were
being silently truncated. A user's choice was lost if they made it before
Claude asked for it. `FrameDecoder` was quadratic. Column widths counted
UTF-16 units, so any CJK or emoji cell sheared its row. Registry writes
were not atomic, and a read that raced one deleted it. None of that was
visible from the outside, and all of it is fixed with a regression test
apiece.

The receipts, if you want them: **293 tests**, CI green on Linux, macOS and
Windows, and `canvas/scripts/smoke.sh` driving seven of the eight canvas
kinds (every one but `document`) through a real tmux pane. `document` is
the one exception because its interaction model doesn't fit the script's
existing pattern: every other kind reports its outcome through `wait`
after keyboard-only input, while `document`'s selection is mouse-drag-based
and read back with `get <id> selection` instead — driving that would need
either simulated mouse events (which `tmux send-keys` cannot produce) or
real per-kind design work, not just another case following the existing
six. Every decision, every ruling and every known gap
is written down in [`docs/roadmap.md`](docs/roadmap.md) and the ledgers
under [`docs/superpowers/`](docs/superpowers/) — including the things that
are still wrong.

## Project status

- **Phase 1 — foundations:** complete. One IPC, three platforms, CI.
- **Phase 2 — generic primitives:** complete. `picker`, `form`, `table`,
  `diff`.
- **Phase 3 — richer canvases:** in progress. Composition and `dashboard`
  are done; image rendering (half-blocks, Sixel, Kitty) is next.
- **Phase 4 — publishing:** not started.

## License

MIT, and the original copyright is retained — see [LICENSE](LICENSE).
