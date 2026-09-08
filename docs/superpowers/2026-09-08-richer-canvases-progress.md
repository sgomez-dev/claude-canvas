# SDD ledger — Phase 3, richer canvases

Spec: docs/superpowers/specs/2026-09-08-richer-canvases-design.md
Plans: to be written per sub-project, in the sequence the spec sets out.
Baseline at d2a1def: `bun test` 261 pass / 0 fail, 24 snapshots,
`tsc --noEmit` clean, CI green on ubuntu-latest, macos-latest and
windows-latest.
Bun 1.4.2, tmux 3.7c (Homebrew), WezTerm 20240203-110809-5046fc22, macOS
arm64, Apple Terminal as the host terminal.

Phase 2 kept its ledger after the fact and said so. This one starts with the
pre-flight facts, because four of them changed the design before a line was
written.

## Pre-flight: facts established before designing

Each of these was checked rather than assumed, and each one moved a decision.

| Fact | How it was established | What it decided |
|---|---|---|
| Windows Terminal has Sixel from 1.22.10352.0 | arewesixelyet.com plus the 1.22 release notes | Discharges the phase's stated entry condition |
| Apple Terminal has **no** graphics protocol; kitty, Ghostty and Alacritty refuse Sixel | same source | Half-blocks are the *common* path, not a fallback; and no single protocol covers the field |
| Homebrew's tmux 3.7c **is** built with Sixel | its binary carries the code, and it accepts a `terminal-features[...]:sixel` entry | The multiplexer is not the blocker; but it must be *told*, which becomes a `spawn`-path concern |
| Ink's `useInput` takes `{ isActive }`, documented for exactly the multiple-hook case | its own type definitions | Focus routing for composition needs no key-dispatch layer of our own |
| `Bun.inflateSync` and `node:zlib` are both present and working | a deflate/inflate round trip | A PNG decoder is ~150 lines with no dependency, so the no-new-dependencies rule survives this phase too |
| `screencapture` is **blocked** for this process by macOS Screen Recording permission | it fails with "could not create image from display" | Graphics cannot be visually verified automatically from here; Sixel needs an independent decoder as an oracle, plus one human check |
| **No Playwright MCP is connected** in this session | the session's MCP list | The roadmap's "already available as an MCP" is stale, and the `image` canvas must not couple to any one capture mechanism |

**Ruling 1: half-blocks are the baseline tier, and the one that must be
provably right.** Not because they are the best, but because Apple Terminal
ships as macOS's default with no protocol at all. A design that treats a
graphics protocol as the normal path and half-blocks as degradation gets the
common case backwards. Half-blocks are also pure ANSI text, so they are the
only tier this repository's existing snapshot harness can verify byte for
byte — the tier that matters most is the tier that can be proven. Cost if
wrong: effort spent on the low-fidelity path that a protocol would have
superseded.

**Ruling 2: no terminal interrogation.** The correct way to ask a terminal
what it supports is a DA1 query, and the reply must travel back through
tmux. A probe that gets no answer either strands the canvas waiting or has
to time out, and a canvas that hangs on startup is worse than one that
paints a lower-fidelity image. Detection is environment-based with an
explicit `CANVAS_GRAPHICS` override, so a wrong guess is never a dead end.
Cost if wrong: a terminal we misclassify paints half-blocks until someone
sets the override.

**Ruling 3: the dashboard renders a config, it does not gather one.** A
canvas that shelled out to `git` and a test runner would need a permissions
story, a refresh story and an error story per command, would be untestable
without a subprocess layer that does not exist, and would make a canvas the
first thing here to execute arbitrary commands. Claude gathers; the
dashboard renders; refresh is the `update` verb added in Phase 2, which
makes the dashboard that work's first real consumer. Cost if wrong: a
refresh costs a round trip through Claude instead of happening in the pane.

**Ruling 4: composition starts with a refactor, not a canvas.** The four
Phase 2 primitives each own an IPC server, a validation pass, a key handler
and one outcome, so none of them can be embedded in anything. Extracting a
view from each is mechanical but touches four working things at once, so the
guard is that every render snapshot stays **byte-identical** — a changed
snapshot is a defect to fix, never a baseline to regenerate. Cost if wrong:
a phase that builds a dashboard out of copy-pasted rendering code and proves
nothing about composability.

## Progress

Nothing implemented yet. Next: the composition plan, per the spec's
sequencing.
