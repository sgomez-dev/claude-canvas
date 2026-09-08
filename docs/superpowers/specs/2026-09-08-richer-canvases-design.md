# Richer Canvases — Design

**Phase 3 of the roadmap in [`docs/roadmap.md`](../../roadmap.md).**
Date: 2026-09-08.

## Problem

Every canvas is standalone. `flight` is 376 lines of bespoke rendering that
duplicates, badly, what `table` and `picker` now do generically. The
roadmap's premise for this phase is that new canvases should **compose**
primitives instead — but there is no composition mechanism, and nothing
about the current shape permits one: each primitive is a top-level canvas
that owns an IPC server, a config validation pass, a key handler and exactly
one outcome. Two primitives cannot coexist in one pane.

On top of that, three backlog items are still open: a project dashboard, a
screenshot of the running app, and Figma/Pencil mockups. The last two need
image rendering, which needs the capability detection Phase 1 deliberately
stubbed out — `baseCapabilities` hardcodes `graphics: "none"` with a comment
saying probing for Kitty, iTerm2 or Sixel "is Phase 3 work and must not be
attempted here".

The roadmap's fourth backlog item, an interactive diff reviewer, was
delivered in Phase 2 as the `diff` primitive. It is not repeated here.

## Entry condition, discharged

The roadmap gated this phase on one fact: *"Sixel support in Windows
Terminal must be verified before committing to this."*

Verified 2026-09-08:

| Terminal | Sixel |
|---|---|
| Windows Terminal | yes, from 1.22.10352.0 |
| iTerm2 | yes, from 3.3.0 |
| WezTerm | yes |
| xterm | yes, default since patch #359 |
| foot | yes, from 1.2.0 |
| VS Code integrated terminal | yes from 1.80, behind `terminal.integrated.enableImages` |
| tmux | yes when built `--enable-sixel` |
| **Apple Terminal** | **no** — no graphics protocol of any kind |
| kitty, Ghostty | no — Kitty graphics protocol instead, by design |
| Alacritty | no — rejected upstream |

Checked locally rather than assumed: Homebrew's tmux 3.7c **is** built with
Sixel (its binary carries the code and it accepts a
`terminal-features[...]:sixel` entry), so the multiplexer this project spawns
into is not the blocker.

Two consequences, both load-bearing on the design below:

1. **Half-blocks are the universal baseline, not a fallback of last
   resort.** Apple Terminal is macOS's default terminal and has no protocol
   at all. A design that treats a graphics protocol as the normal path and
   half-blocks as degradation gets the common case backwards.
2. **No single protocol covers the field.** Sixel covers six terminals; the
   two that refuse Sixel on principle both implement the Kitty protocol.
   Supporting exactly one means abandoning a chunk of users either way.

## Success criteria

- A canvas can be built by composing primitive **views** rather than
  re-implementing them, and `dashboard` demonstrates it with at least three
  region kinds in one pane.
- The four Phase 2 primitives keep working through that refactor with
  **byte-identical render snapshots** and unchanged IPC tests. This is the
  guard, not a nice-to-have: the refactor's whole risk is silently changing
  four things that currently work.
- `dashboard` refreshes in place through the existing `update` verb, with no
  new IPC capability.
- `graphics` capability detection reports a real answer per terminal, with an
  explicit override, and `image` renders a PNG at the best tier the terminal
  supports.
- Half-block rendering is covered by byte-stable snapshots. It is the tier
  every user gets, so it is the tier that must be provably right.
- Sixel output is verified against an **independent** decoder, not only
  against our own.
- No new runtime dependencies. Held through every task of Phases 1 and 2;
  PNG decoding does not justify breaking it (see below).

## Non-goals

- **Rewriting `flight`.** Whether it should exist at all is a separate
  question; composing it out of primitives is a demonstration, not a
  requirement of this phase.
- **A layout engine.** Regions stack vertically with explicit or shared
  heights. No grids, no splits, no resizing. Ink's flexbox is doing the work
  and inventing a second layout language on top would be the wrong kind of
  ambition.
- **Interactive images.** No panning, zooming or clicking into an image.
- **Video, animation, or streaming frames.** A canvas paints one image per
  config.
- **Mockup fetching.** The `image` canvas takes an image; where it came from
  — Figma MCP, a screenshot tool, a file on disk — is the caller's business.
  See sub-project 4.

---

## Sub-project 1: Composition

### The split

Each primitive becomes two things:

- **A view** — `canvases/<kind>/view.tsx`, exporting e.g.
  `PickerView({ config, focused, onSubmit, onCancel, rows })`. Owns its
  local interaction state (cursor, checked set, scroll offset) and its key
  handling, and renders. Knows nothing about IPC, registry records or
  outcomes.
- **A canvas shell** — `canvases/<kind>.tsx`, unchanged in behaviour: it
  validates the config, owns `useCanvasServer`, wires `onUpdate`, reports the
  outcome, and mounts its own view with `focused` permanently true.

Config validation moves to `canvases/<kind>/validate.ts` as a pure function
returning `{ data, error }`. Both the shell and any composing canvas call it,
so a region with a bad config is reported the same way a whole canvas with a
bad config already is.

### Focus

Ink's `useInput` takes an `{ isActive }` option whose documented purpose is
exactly this case: *"Useful when there are multiple `useInput` hooks used at
once to avoid handling the same input several times."* So focus routing is
`isActive: focused` on each view, and needs no key-dispatch layer of our own.

`Tab` / `Shift+Tab` cycle the focusable regions. A region whose kind has no
interaction (`text`) is skipped. The focused region is marked in a way that
survives a no-color terminal — the lesson `picker`'s cursor gutter and
`form`'s `<- required` marker both had to learn.

**`Escape` belongs to the shell and is never delegated.** Every primitive
already treats "Escape must always work, in every state" as a hard rule; a
composed canvas with a region that swallowed it would be un-exitable by
keyboard, which is the failure the rule exists to prevent.

### Outcome

A composed canvas still produces exactly one outcome — first-outcome-wins is
unchanged. When a region submits, the outcome carries which region it was:

```ts
interface CompositeResult {
  regionId: string;
  result: unknown; // that view's own result shape
}
```

Without `regionId` a controller receiving `{"selectedIds":["x"]}` from a
three-picker dashboard could not tell which question was answered.

### Migration guard

The refactor is mechanical but wide. The guard is that
`bun test` must stay green with **no snapshot regenerated**: if a view
extraction changed a render, that is a defect to fix rather than a baseline
to update. Phase 2's plans already state this rule; here it is the only
thing standing between a refactor and four silent regressions.

---

## Sub-project 2: Project dashboard

The roadmap calls this "cheapest to build and the most likely to see daily
use". It is also the honest test of whether the composition above is worth
anything.

### Config-driven, not self-gathering

**The dashboard does not run `git`, a test suite, or anything else.** It
renders a config that Claude produces, exactly as every other canvas does.

The alternative — a canvas that shells out to gather its own data — would
need a permissions story, a refresh story, an error story for every command
it runs, and would be untestable without mocking a subprocess layer that
does not exist. It would also make a canvas the first thing in this codebase
to execute arbitrary commands, which is a large security surface to open for
a convenience.

Refresh is `update <id> --config-file <path>`, the verb added in Phase 2.
Claude re-gathers and pushes. That makes the dashboard the first real
consumer of that work, and requires no new IPC capability.

### Regions

Four region kinds, three of them already built:

| Region kind | View | Content |
|---|---|---|
| `table` | existing `table` view | test results, dependency versions, anything tabular |
| `picker` | existing `picker` view | TODOs or files to act on — returns a choice |
| `text` | new, trivial | git status, a summary line, a file tree rendered by Claude |
| `tree` | new | a file tree with collapse/expand |

`tree` is the only genuinely new view. It is included because a file tree is
the one thing on the roadmap's list that no existing primitive covers and
that a text region renders badly (no collapsing, no navigation).

### Config

```ts
interface DashboardRegion {
  id: string;                    // unique within the canvas
  title?: string;
  kind: "table" | "picker" | "text" | "tree";
  rows?: number;                 // fixed height; omitted regions share the rest
  config: unknown;               // that view's own config
}

interface DashboardConfig {
  title?: string;
  regions: DashboardRegion[];
}
```

Rejected at config time, reported through `sendError` like every other
primitive: an empty `regions` array, a duplicate region id, an unknown
region kind, or a region whose own config its view rejects.

---

## Sub-project 3: Image pipeline

### Capability detection

`graphics` becomes `"kitty" | "iterm2" | "sixel" | "halfblocks" | "none"`.
`"halfblocks"` is the answer for a terminal with no protocol but a working
TTY — which is most of them. `"none"` is reserved for no TTY at all.

Detection is **environment-based, with an explicit override**
(`CANVAS_GRAPHICS`). Deliberately **no terminal interrogation**: the correct
way to ask a terminal what it supports is a DA1 query, and the reply has to
travel back through tmux, which may or may not pass it. A probe that gets no
answer either strands the canvas waiting or has to time out, and a canvas
that hangs on startup is worse than one that paints a lower-fidelity image.
The override exists so a user whose terminal we guess wrong about is never
stuck.

Order: `CANVAS_GRAPHICS` if set, then `KITTY_WINDOW_ID`/`TERM=xterm-kitty`
and Ghostty (kitty), then `TERM_PROGRAM=iTerm.app` (iterm2, which is also
Sixel-capable but its own protocol is better), then the Sixel set
(Windows Terminal by `WT_SESSION` plus version, WezTerm, xterm, foot, VS
Code), then `halfblocks`.

**Detection alone is not sufficient inside tmux.** tmux must also be told
the outer terminal has the feature, or it will not pass the escapes through.
The `spawn` path therefore sets the `sixel` terminal-feature on the tmux
server when it detects a Sixel-capable outer terminal, and the reasoning goes
in a comment, because this is exactly the kind of thing that looks like an
unnecessary side effect to whoever reads it next.

### PNG decoding without a dependency

`Bun.inflateSync` and `node:zlib` are both available in Bun — verified, with
a deflate/inflate round trip. So a PNG decoder is chunk parsing plus inflate
plus scanline un-filtering: on the order of 150 lines, no dependency, no
reaching into a transitive one.

Supported subset, stated up front rather than discovered: 8-bit-per-channel
RGB and RGBA, non-interlaced. Palette, greyscale, 16-bit and interlaced PNGs
are reported as a clear config error. Every screenshot tool in the intended
path emits 8-bit RGB/RGBA.

### Half-blocks

The `▀` character with a foreground and a background colour paints two
vertical pixels per cell, so a cell grid of W×H represents W×2H pixels. The
source image is box-averaged down to that grid.

This is the tier every user gets, and unlike the protocol tiers it is
**pure ANSI text** — which means it is byte-snapshot-testable with the
harness already in the repository. That is the strongest verification any
part of this sub-project can have, and it applies to the part that matters
most.

### Sixel and Kitty

Sixel: six vertical pixels per band, colour registers declared up front. The
palette is quantised to at most 256 colours; the quantiser is the only piece
with real algorithmic content and gets its own unit tests.

Kitty: base64 of the raw RGB/RGBA payload inside `\x1b_G...\x1b\\`, chunked
at 4096 bytes. Almost no encoding logic, so almost no room for encoding bugs.

### Verification strategy

This is the part of the phase that cannot be verified the way everything
else in this repository has been, and pretending otherwise is how Phase 1
shipped two defects that were invisible on the machine they were written on.

- **Half-blocks: fully verified.** ANSI text, byte-stable snapshots.
- **Sixel: verified against an independent decoder.** Our encoder's output
  is decoded by `sixel2png` from libsixel and compared pixel-wise against
  the source image. libsixel is a **development** tool, not a runtime
  dependency, and the test skips when it is absent so CI stays green
  regardless. Round-tripping through our own decoder instead would prove
  only that we are consistently wrong.
- **Kitty: unit-tested by construction.** The payload is base64 of known
  bytes; the framing is asserted directly.
- **One human confirmation, once.** `screencapture` is blocked for this
  process by macOS Screen Recording permission, so the "launch WezTerm and
  look at it" check cannot be automated from here. It becomes a one-off ask:
  a probe canvas is opened in WezTerm and a person confirms the image
  appears. Recorded in the ledger as human-verified, with the date and the
  terminal version, rather than claimed as tested.

---

## Sub-project 4: Screenshot and mockups

One canvas, `image`, and it takes an image:

```ts
interface ImageConfig {
  title?: string;
  path?: string;        // a PNG on disk
  base64?: string;      // or the bytes inline
  maxRows?: number;     // cap the painted height
  fit?: "contain" | "width";
}
```

**Where the image comes from is not this canvas's problem.** The roadmap
says "capture the dev server with Playwright (already available as an MCP)",
and that is now stale — no Playwright MCP is connected in this session,
though `agent-browser` and `playwright-recording` skills exist. Coupling the
canvas to any one capture mechanism would have dated it the same way. Claude
captures with whatever it has and passes the result.

That decision also collapses the roadmap's items 2 and 3 into one canvas: a
screenshot of a running app and a Figma frame are both a PNG.

The `image` canvas is view-only, like `table`: it closes with `cancelled`.
Composing it into a side-by-side design-versus-implementation comparison is
a later exercise and needs the horizontal layout this phase explicitly does
not build.

---

## Sequencing

Four plans, in this order, each shippable on its own:

1. **Composition** — extract four views, add the focus contract, keep every
   snapshot byte-identical. Nothing user-visible; entirely a risk-reduction
   step for what follows.
2. **Dashboard** — the `tree` view, the `dashboard` canvas, region
   validation, refresh through `update`. First user-visible payoff, and
   fully verifiable on any machine.
3. **Image pipeline** — capability detection, the PNG decoder, half-blocks,
   Sixel, Kitty, and the tmux passthrough. The only sub-project with a
   verification gap, and the one that needs the human check.
4. **Image canvas** — the canvas itself, plus the skill telling Claude when
   to reach for it.

Steps 1 and 2 are text-only and carry no verification risk. Step 3 is where
the care goes.
