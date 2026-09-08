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

### Sub-project 1: composition — COMPLETE

Each of the four Phase 2 primitives is now a **canvas shell** plus a
**view** plus a pure **validate** function:

| Primitive | Shell | View | Validate |
|---|---|---|---|
| `picker` | 117 | 177 | 74 |
| `table` | 99 | 128 | 58 |
| `diff` | 108 | 225 | 26 |
| `form` | 104 | 304 | 78 |

The shell owns the live config, validation, the IPC server, Escape and the
single outcome. The view owns rendering and local interaction and knows
nothing about IPC, registry records or outcomes.

**The guard held: 24 render snapshots, not one regenerated.** The JSX was
moved by slicing the original files line by line rather than retyped, which
is why. `bun test` 261 pass / 0 fail, `tsc --noEmit` clean, and the tmux
smoke script 12 pass / 0 fail in a real pane -- run because this refactor
moved Escape out of every view, so two `useInput` hooks are now live at
once.

**Ruling 5: Escape belongs to the shell, and the shell keeps it always
active.** A view that swallowed Escape would make a composed canvas
un-exitable through whichever region happened to be focused. Keeping it in
the shell also means it still works from the config-error state, where no
view is mounted at all -- which is the regression `diff`'s
"Escape still cancels from the parse-error state" test was written for. Cost
if wrong: two active input hooks instead of one, which Ink handles by
design.

**Ruling 6: reset by remounting the view, not by clearing state.** Each
shell keys its view on a `generation` counter bumped on every pushed config.
That replaced four hand-written reset effects. A pushed config is a new
question, so *every* piece of state referring to the old one has to go, and
"throw the component away" is exhaustive in a way a hand-written reset is
not -- `form`'s values are keyed by field id and `diff`'s decisions by hunk
id, so a missed reset silently misattributes an answer. Cost if wrong: a
remount costs one extra render on an update, which happens only when a
controller pushes one.

**Ruling 7: prove the mechanism before building on it.** Byte-identical
snapshots show the extraction broke nothing and say nothing about whether it
*enabled* anything. `test/composition/focus.test.tsx` mounts two picker
views in one pane, moves focus with Tab, and asserts only the focused one
consumes keys -- plus that a view windows to the `rows` budget it is handed
rather than the terminal height, which is how a region gets a slice of the
pane. Confirmed load-bearing: with `{ isActive: focused }` removed from one
view, two of those four tests fail because both views answer the same
keystroke.

**Ruling 8: assert a focus change and focus routing separately.** The first
version of the focus test Tabbed to region B and then immediately drove it,
and failed on all three CI legs while passing locally. `isActive` takes
effect when Ink re-registers its input handlers, which happens in a passive
effect after the render that changed focus -- so a keystroke arriving in the
same tick as the Tab is still routed by the previous assignment. That is a
real property, not a bug: no human types inside one tick, but a test firing
keystrokes back to back does.

So the two properties are now asserted apart: that Tab moves the indicator
(from the render, deterministic) and that the focused view is the one that
answers (mounted with focus already there, no change in flight). 25
consecutive runs clean, and removing `isActive` still fails two of the five
tests, so the guard survived the restructuring. Cost if wrong: nothing
asserts the specific sequence "Tab, then type immediately", which no
interactive user can produce.

This is the third time in this project that a test asserted on a deadline
rather than a condition and was caught only by CI. Worth reading as a
pattern: the harness makes it very easy to write, and only a loaded runner
tells you.

### Found during the extraction, not fixed

**`form` has no viewport.** It is the one primitive that never got one: a
form with more fields than the pane has rows overflows, exactly as `picker`,
`diff` and `table` did before Phase 2 gave them windows. Left alone here
deliberately -- adding one changes a render, and this sub-project's entire
guard was that no render changed. Recorded as the first item for whoever
picks up sub-project 2, since a form region inside a dashboard makes it
worse.

### Sub-project 2: dashboard — COMPLETE

New: `tree` (view + validator + types), `dashboard` (canvas + validator +
types), the `dashboard:display` scenario, and a viewport for `form`.

`form` was the item sub-project 1 recorded and did not fix. It is fixed
here, and it was the worst of the four overflows: `picker`, `diff` and
`table` overflowing hid content, while `form` overflowing pushed the
**Submit button** off screen, leaving a form that could be filled in and not
submitted. Windowed on the focus index, with the Submit position belonging
to the last page so it is always reachable. Existing snapshots unchanged --
the fixtures are short enough not to window.

`tree` is the one region kind no existing primitive covered: a `text` region
renders a tree badly (no folding, no navigation) and `picker` flattens away
the structure that makes a tree worth showing. Folds with the arrow keys,
and folding a leaf walks up to its parent instead, which is what makes the
left arrow usable for climbing out.

**Ruling 9: region configs are validated by the region kind's own
validator.** `validateRegionConfig` dispatches to `validatePicker`,
`validateTable`, `validateForm`, `validateTree` and `parseDiffConfig` -- the
five functions sub-project 1 extracted. Re-implementing those checks in the
dashboard would have meant six validators drifting away from the six they
duplicate, and a region error that read differently from the identical
canvas error. This is the concrete payoff of that extraction, and the test
`a region's own config is validated by that kind's validator` pins it. Cost
if wrong: a region config is validated twice, once by the dashboard and once
by the view it mounts.

**Ruling 10: the dashboard renders a config and gathers nothing.** As ruled
in the pre-flight. Refresh is the `update` verb, which makes the dashboard
that Phase 2 work's first real consumer -- covered by `a pushed config
refreshes the regions in place`.

**Ruling 11: an outcome carries the region that produced it.** Without
`regionId` a controller receiving `{"selectedIds":["a.ts"]}` from a
dashboard with two pickers could not tell which question was answered.
First-outcome-wins is unchanged, so only one region can ever answer. Cost if
wrong: one extra field on every composed result.

**Ruling 12: rows are allocated, never dropped.** A region with explicit
`rows` gets it, the rest share what is left, and nothing goes below three
rows even if the total then overflows. Dropping a region instead would hide
content the caller asked for, and a region too short to draw its own border
is worse than a pane that scrolls.

Verified: 293 tests / 0 fail, `tsc` clean, and the smoke script 13 pass / 0
fail in a real tmux pane -- the dashboard case drives a two-region config
and asserts the outcome carries `regionId`.

### Found in sub-project 2, not fixed

**Each region repeats its own footer hint, and one of them is wrong.** A
picker region's footer says "Esc: cancel" while Escape actually closes the
whole dashboard. Three regions means three hint lines competing with the
dashboard's own. The fix is an optional `hint` prop on each view, defaulting
to true so standalone renders are untouched, with the dashboard suppressing
them and naming the focused region's keys in its own footer. Left for
whoever picks this up: it is wrong information rather than wrong behaviour,
and the dashboard is legible without it.

**A region's chrome overhead is not obvious from the config.** A `table`
region given `rows: 7` shows one data row, because the view spends six on
its own border, header and footer. Documented in the dashboard skill; a
better answer would be for a region to render without its own border and let
the dashboard draw the separators, which is a layout change this phase's
non-goals rule out.

### Interlude: the plugin was not actually installable

Not part of any sub-project, done because the question "how do I try this?"
turned out to have the answer "you cannot".

A `/plugin install` arrives as a git clone with no `node_modules`, and every
skill told Claude to run `bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, which
imports ink, which imports react. Verified against a real install from the
marketplace: `Cannot find package 'react'`. Anyone following the README
would have installed it, asked for a canvas and got nothing.

Fixed by shipping `canvas/dist/cli.js`, a 1.32 MB bundle with no runtime
imports at all, with the 42 command references across the skills and
`/canvas` pointing at it.

**Ruling 13: a committed build artifact, guarded by two CI checks.** Putting
a build output in version control is normally wrong; here it is the only way
an install works with no setup step. The cost is that it can go stale
silently, so `build:check` rebuilds and byte-compares it, and
`check:standalone` runs it in a temp directory where it is the only file.
The second check exists because **two plausible changes broke the bundle's
one required property and neither showed up in 293 tests** -- the suite runs
inside the repository, where every dependency is present:

- `spawn` built its child's argv as `${import.meta.dir}/cli.ts`, a hardcoded
  filename. From the bundle that is a `cli.ts` which does not exist, so the
  pane opened and the canvas died instantly. Now `import.meta.path`.
- `--external react-devtools-core` left a runtime import of a package the
  plugin cannot resolve. Now resolved to a stub by a Bun.build plugin.

Cost if wrong: a 1.3 MB artifact in history per source change, and two extra
CI steps.

Worth noting that the "did not become reachable within 10s, see the log"
error added when outcomes were made durable is what diagnosed the first of
those in a single read, rather than presenting as a silent hang.

### Next: sub-project 3, the image pipeline

Capability detection, the PNG decoder, half-blocks, Sixel, Kitty, and the
tmux passthrough. The only sub-project with a verification gap.

**Everything needed to start is already established** (see the pre-flight
table above): the terminal support matrix, that Homebrew's tmux 3.7c carries
Sixel, that `Bun.inflateSync` works so a PNG decoder needs no dependency,
and that `screencapture` is blocked for this process so graphics cannot be
verified visually by automation from here.

**Verification tooling, current state:**

- **WezTerm 20240203 is installed** (`/opt/homebrew/bin/wezterm`) and is
  Sixel-capable, for the one human check the spec calls for.
- **`libsixel` is NOT installed.** `brew install libsixel` provides
  `sixel2png`, which is the independent decoder the spec wants as an oracle:
  encode with our code, decode with libsixel, compare pixel-wise to the
  source. It is a development tool, not a runtime dependency, and the test
  must skip when it is absent so CI stays green.
- `screencapture` fails with "could not create image from display" -- macOS
  Screen Recording permission for this process. Granting it would let the
  WezTerm check be automated; without it, that check stays a one-off ask.

**Order to work in**, per the spec: capability detection and the
`CANVAS_GRAPHICS` override first (pure logic, fully testable), then the PNG
decoder (pure logic, fully testable), then half-blocks (pure ANSI text, so
byte-snapshot-testable -- and the tier every user gets, so the tier that
must be provably right), then Sixel against the libsixel oracle, then Kitty,
then the tmux passthrough that `spawn` has to set up.

**Do not start with Sixel.** It is the part that cannot be verified from
here without installing libsixel, and the two tiers before it carry no
verification risk at all.
