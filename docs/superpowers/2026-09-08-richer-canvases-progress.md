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

### Found during the extraction, deferred to sub-project 2 — since FIXED

**`form` had no viewport.** It was the one primitive that never got one: a
form with more fields than the pane has rows overflowed, exactly as
`picker`, `diff` and `table` did before Phase 2 gave them windows. Left
alone during the extraction deliberately -- adding one changes a render, and
that sub-project's entire guard was that no render changed.

**Fixed in sub-project 2**, where it turned out to be the worst of the four
overflows: the others hid content, while form's pushed the Submit button off
screen, leaving a form that could be filled in and not submitted.

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

**STILL OPEN: each region repeats its own footer hint, and one of them is
wrong.** A picker region's footer says "Esc: cancel" while Escape actually
closes the whole dashboard. Three regions means three hint lines competing
with the dashboard's own. The fix is an optional `hint` prop on each view,
defaulting to true so standalone renders are untouched, with the dashboard
suppressing them and naming the focused region's keys in its own footer;
each view's chrome then shrinks by the footer's two rows (its blank line
and its text).

Attempted and abandoned 2026-09-09, deliberately: it needs a coordinated
edit across five views plus the dashboard, for text that is wrong rather
than behaviour that is wrong, and the session's actual instruction was to
advance the image pipeline. **It is a smaller job now than it was**: every
view renders its hint from a single constant, so suppressing it is one
conditional per view rather than an edit to a duplicated literal.

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

### Sub-project 3, step 1: capability detection — DONE

`host/graphics.ts`: a `GraphicsTier` of `kitty | iterm2 | sixel |
halfblocks | none`, `detectGraphics(env)`, and `resolveGraphics(env, passed)`.
12 unit tests. `--graphics` threaded from `spawn` to `show`, and `env` now
reports capabilities whether or not a host is available.

**Ruling 14: the controller detects the tier and passes it down; a canvas
cannot detect it at all.** This inverted the design, and only measuring
found it. Inside tmux, `TERM_PROGRAM` becomes `tmux` and `TERM` becomes
`tmux-256color` — the outer terminal's identity is **erased, not obscured**.
Since `spawn` always runs a canvas inside a pane, environment detection from
the canvas can never see past the multiplexer, and every spawned canvas
would have been stuck on the baseline tier no matter what the terminal could
do. The controller runs in the user's shell where the real values survive,
so it detects and hands the answer down as `--graphics`, and `show` writes
it into its own environment so `baseCapabilities`, `ready`'s capabilities
and the eventual renderer all resolve the same value with no further
plumbing. Cost if wrong: one extra argv pair per spawn.

**Ruling 15: no tier is ever inferred from `TERM`.** `TERM=xterm-256color`
is what Apple Terminal sets, and it supports no image protocol whatsoever;
xterm's own Sixel support is both patch-dependent and a compile-time option.
Inferring Sixel from `TERM=xterm*` would emit escapes that render as
garbage in a large fraction of terminals, which is a far worse failure than
painting blocks. Detection uses explicit program markers only
(`TERM_PROGRAM`, `KITTY_WINDOW_ID`, `WT_SESSION`, `WEZTERM_EXECUTABLE`,
`GHOSTTY_RESOURCES_DIR`, `LC_TERMINAL`), and there is a test asserting
`TERM=xterm*` alone never implies sixel.

**Ruling 16: Windows Terminal is treated as Sixel-capable, knowingly.**
`WT_SESSION` is present in every version and there is no version variable,
so this cannot distinguish 1.22+ (which has Sixel) from older builds. Since
1.22 shipped in 2024, assuming capable serves current installs and leaves
stale ones an escape hatch; the reverse would penalise everyone for the
minority. An old Windows Terminal renders garbage and needs
`CANVAS_GRAPHICS=halfblocks`, which is documented. Cost if wrong: a stale
Windows Terminal shows garbage until its user sets one variable.

**Ruling 17: a misspelled override is an error, not a fallback.** Someone
who sets `CANVAS_GRAPHICS=sixl` meant something by it; silently painting
blocks would tell them nothing. `env` surfaces the message in a
`capabilitiesError` field — and `env` reports capabilities even with no host
available, since they describe the terminal rather than the pane host, and
`env` is exactly the command someone runs to ask why their images look like
blocks.

### Detour, taken while checking what was still pending: footer hints

Two things, both found by reading rather than by a failure.

**The measured footer string and the rendered footer string were separate
literals, in all five views.** The wrap budget the merge review added
measures `FOOTER_HINT` to reserve rows for a hint that wraps at a narrow
width -- but every view then printed its own duplicate copy of that text in
the render. Editing the visible hint would have silently mismeasured its
height, reserving rows for a string no longer on screen. Exactly the drift
shape `CLAUDE.md`'s "Verifying a fix" section catalogues.

Latent, not active: unifying them moved **no snapshot at all**, which is the
evidence that the two copies still agreed. Now structurally impossible --
each view renders the constant it measures. `diff` gained a second constant
for its no-hunks footer, which it rendered while measuring the long one and
so over-reserved a row.

**`tree` never received the footer-wrap budget the other four have**, having
been written after that wave. At a narrow width its own hint wraps onto a
line `CHROME_ROWS` does not reserve, pushing a row of content out of the
pane. Fixed, with a test that compares the window size at 80 and 34 columns
and asserts the render never exceeds its budget -- confirmed to fail with
the budget removed.

### Sub-project 3, step 2: the PNG decoder — DONE

`canvases/png.ts`, 236 lines, no dependency: chunk parsing, `node:zlib`'s
inflate, and scanline un-filtering. Output is normalised to RGBA even for an
RGB source, so half-blocks, Sixel and Kitty each handle one layout instead
of branching on channel count. 16 tests.

**Ruling 18: the supported subset is stated, and each refusal names what the
file actually is.** 8-bit RGB and RGBA, non-interlaced. Palette, greyscale,
greyscale-with-alpha, 16-bit and interlaced are refused with the format
named -- every screenshot tool in the intended path emits 8-bit RGB or
RGBA, and a silent wrong render is worse than a refusal, while
"unsupported" with no detail sends the caller guessing. Cost if wrong: a
caller with a palette PNG has to convert it, and is told so.

**Ruling 19: the pixel ceiling is checked before allocating.** A PNG header
is eight bytes that can claim any dimensions, so a malformed file could ask
for tens of gigabytes. 16 megapixels covers 4K with room to spare -- the
same check-before-allocating discipline `protocol.ts` applies to its frame
ceiling, and there is a test asserting a 65535x65535 header is refused
rather than attempted.

**Ruling 20: CRCs are deliberately not verified.** A corrupted chunk almost
always makes inflate fail, which surfaces as an error anyway; checking them
would add a table and a pass over every byte to catch the narrow case where
corruption inflates cleanly. Cost if wrong: a pathologically corrupt file
renders wrong instead of being refused.

**Verified against an independent decoder, not just a round trip.** The
repository's own `media/screenshot.png` is 3384x2160 8-bit RGBA split across
hundreds of 4096-byte IDAT chunks, which is what exercises the chunk
joining. Its expected pixel values and a checksum over all 29 million bytes
were produced by a separate Python implementation over zlib -- a round trip
against my own encoder cannot catch a decoder that is consistently wrong.
That real file uses only filter type 2, so the other four filters get
hand-built fixtures with correct CRC32s, which is where Average and Paeth
are exercised: both read the pixel above-left and both must treat
out-of-bounds as zero.

### Sub-project 3, step 3: half-blocks — DONE

`canvases/halfblocks.ts` (pure, 143 lines) plus `canvases/halfblock-view.tsx`
(the Ink component). 18 tests. The tier that works everywhere, and the only
one made of ordinary styled text -- which is why it is the only one the
snapshot harness can pin byte for byte.

**Ruling 21: one cell carries two pixels, the upper as the glyph's
foreground.** `▀` with a foreground and a background colour paints the top
half in the foreground and leaves the bottom half showing the cell
background, so a W×H cell grid represents W×2H pixels. Swap the two and
every image renders vertically mirrored in stripes -- which looks like a
plausible image, not like a crash, so it is asserted directly rather than
left to a snapshot to notice. Cost if wrong: every image is subtly upside
down and nobody can say why.

**Ruling 22: downscaling box-averages, and the test must span more than one
source row.** A nearest-neighbour downscale of a screenshot drops entire
rows of text, which is exactly the content this tier exists to keep
legible. The test that matters here was **missing until sabotage found it**:
replacing the vertical loop with a single sampled row left all 17 other
tests green, because each of them happened to map exactly one source row per
target pixel row -- so the whole file was testing the horizontal average
only. `downscaling averages DOWN the box, not just across it` closes it, and
the gradient snapshot now uses a 16×16 source in an 8×4 grid so every target
pixel is a 2×2 box. Both axes and the empty-span guard are sabotage-checked.

**Ruling 23: adjacent cells sharing a colour pair collapse into one run.** A
solid 80×24 pane is 1920 cells, and Ink measures and lays out every element;
runs collapse that to 24. Measured on the repository's own screenshot at
76×24: 1824 cells become 814 runs, so 45% of the elements. The pure function
returns runs rather than cells so the component cannot forget to coalesce.

**Ruling 24: alpha is composited over a caller-supplied background,
defaulting to black.** A terminal cannot report its own background colour,
so a transparent pixel has to resolve to something and the caller is the
only one who might know. Not a naive halving: the test pins `#ff7f7f` and
not `#ff8080` over white, because alpha 128/255 is a hair over one half.

**Ruling 25: the height is halved in exactly one place, `fitToCells`.** A
terminal cell is about twice as tall as it is wide and a half-block cell
holds two stacked pixels, so a cell is roughly square in pixel terms. Doing
that division anywhere else as well would squash every image by two, so the
renderer takes a cell grid and asks no questions about aspect.

**Measured on 2026-09-09: Ink 6 emits raw 24-bit `38;2;r;g;b` for a hex
colour at every `FORCE_COLOR` level, including `"1"`.** That matters twice
over. It means these snapshots pin the exact averaged colour of every pixel
rather than only the layout, so a one-off in the box average moves them. And
it means Ink does *not* quantise to the level it detected -- the escape it
writes to a 256-colour terminal is the same one it writes to a truecolour
one. The test harness pins `FORCE_COLOR="1"`, which in chalk's own scale
means 16 colours, and the emitted bytes were truecolour regardless.

**Verified against an independent oracle over real data.** The repository's
`media/screenshot.png` (3384×2160) rendered to a 76×24 grid, and all 1824
cells compared against a box-average written separately in Python from the
description rather than ported line by line from the TypeScript -- which is
what catches a transposed row/column, an inverted foreground/background or
an off-by-one at a box edge. Zero discrepancies. The decoder feeding it was
itself verified against a separate Python decoder in step 2, so neither half
is checking its own work.

### Settled: Apple Terminal does render 24-bit colour

Measured 2026-09-09 by a human at a real Terminal.app (version 2.15) --
`printf '\033[38;2;255;0;0mROJO\033[0m\n'` printed red. So the default
macOS terminal honours the escapes Ink emits, half-blocks renders at full
fidelity there, and **no 256-colour fallback is needed**. This was the one
thing the tier's correctness hinged on and it is now answered, not assumed.

Two things worth keeping for whoever reads this next.

**The agent's shell cannot run the decisive test.** A DECRQSS round trip
(set a 24-bit colour, ask the terminal to read its own SGR state back) needs
a controlling terminal, and `/dev/tty` fails with `ENXIO` here. If this
question comes up again for another terminal, ask a person to run one
`printf` rather than building something clever.

**Do not reason from the absence of a terminfo `-direct` entry.** That is
the path this session started down -- Apple's `nsterm` and `nsterm-256color`
both declare `colors#256` with no `setrgbf`/`setrgbb`, and there is no
`nsterm-direct`, which looked like evidence. It is not: the terminfo
database shipped on this macOS has **no `-direct` entries at all**, not
`xterm-direct`, not `iterm2-direct`, not `vte-direct`. Absence there says
something about the age of Apple's ncurses database and nothing whatsoever
about the terminal. `COLORTERM=truecolor` was the accurate signal, and
`supports-color` keys off exactly that.

### The `image` canvas — DONE

Registered in all three places the CLAUDE.md checklist names, so `spawn
image` is reachable: `KIND_DEFAULT_SCENARIO` in `cli.ts`, a case in
`renderCanvas`, and `image:display` in the scenario registry. Three files as
the anatomy requires -- `image.tsx` (shell), `image/view.tsx`,
`image/validate.ts` -- plus a skill, and updates to the main canvas skill,
`README.md` and `commands/canvas.md`. 22 tests. 484 in total.

**Ruling 26: the decode lives in the shell, not the validator.** Every other
validator here is pure, and this one stays pure: a `path` is shape-checked
only, because whether the file exists, is readable and is really a PNG can
only be answered by reading it. So the shell has two error sources -- a
config the validator rejected and a file that turned out not to be a PNG --
and funnels both through one channel. Base64 *is* decoded in the validator,
since that needs no I/O. Cost if wrong: a composing canvas could not
validate a region config without touching the disk.

**Ruling 27: exactly one of `path` and `data`.** Both set is rejected rather
than one silently winning, because then the other's typo would be
invisible. `data` exists at all because a controller and a canvas need not
share a filesystem: the canvas runs on the machine hosting the terminal.

**Ruling 28: the view takes no `focused` prop.** Every other view here takes
one and gates its keys on it. This one has no keys -- the image is scaled to
the pane, so there is nothing to scroll or pan -- and a prop accepted and
ignored reads as a contract to whoever finds it next.

**Ruling 29: the footer string that is measured is the string that is
rendered.** `${'${image.width}×${image.height}'}` plus the hint, bound once and used for both
the wrap budget and the render. This is the same defect that was latent in
five views earlier this phase, so it was not going to be reintroduced in the
sixth.

**Sabotage-checked, and two mechanisms did not survive it.** Four
sabotages of the surviving code are caught: not reporting a decode error
(1 fail), a title that does not cost its row (2), a footer that drops the
dimensions (5), and an image that ignores the chrome and overflows the pane
(3).

Two things I had copied from the primitives turned out to cause nothing, and
both are now gone rather than left as scaffolding:

- **The `generation` counter.** The four primitives remount their view on a
  pushed config because their interaction state is keyed by field or hunk
  id. `ImageView` holds no state at all, so deleting the `key` moved no
  test. Removed, with a note to add one back the moment the view grows zoom
  or pan.
- **`sentRef.current = false` in `onUpdate`.** Meant to re-arm the error
  channel so a second bad config reports its own reason. It cannot: an
  error is a **terminal outcome**, and `emitOutcome` returns early once one
  exists (`if (outcomeRef.current) return;`). The second report was already
  being dropped by the runtime, so re-arming only made the shell attempt
  it.

**A protocol consequence worth knowing before writing a controller.** Once
any config is rejected, the canvas has spent its single answer: a second bad
config reports nothing, and a controller attaching afterwards is replayed
the FIRST error rather than the current state. There is a test pinning
exactly that, written after my own assumption to the contrary failed. The
four primitives carry the same inert `sentRef` reset -- a follow-up, not
touched here, because a drive-by edit across four shells is not this step.

### Residual: the in-flight read guard is correct and untested

The load effect discards a decode that resolves after the config changed.
The race is real and reachable -- the `await` on the file read is a genuine
yield point, so a config pushed during it runs the cleanup and starts a
second read while the first is suspended -- and the guard is NOT covered by
a test. Two attempts, both recorded so nobody repeats them:

1. **Through IPC.** Push a slow payload, then immediately a fast one.
   `decodePng` is synchronous, so a payload slow enough to overlap also
   blocks the event loop the IPC needs: the first attempt failed with
   "handshake failed", and a second version **hung for over four minutes**
   rather than failing. The hang was not diagnosed. A hanging test is worse
   than no test, so it was removed.
2. **Through props.** Re-render the root with a new `config`. Does not
   reach it: the config lives in `useState`, fed only by IPC, so a prop
   change is ignored by design. The `rerender` helper added to the harness
   for this was removed again, since nothing used it.

What would make it testable: an asynchronous or chunked decoder, or a seam
that lets a test drive the config without a socket. **Do not remove the
guard on the strength of no test covering it** -- the comment in
`image.tsx` says so too.

### Found while smoke-testing: the pane capture proved nothing

`smoke.sh` captured each pane at a fixed moment after the record appeared.
For `image` that landed on the "Loading media/screenshot.png…" frame, so the
one case whose whole point was visual evidence was showing the state before
the image existed. The outcome assertion still passed, which is exactly how
a check that verifies nothing looks from the outside.

Fixed with `wait_for_pane`, which polls `capture-pane` for a marker the case
declares, and **counts as a pass or a fail** rather than merely delaying the
screenshot. The image case declares `▀`. Verified in a real tmux pane on
Apple Terminal: the pane shows the marker in under a second and the
screenshot renders. 16 smoke cases, 0 fail.

### Also measured: the decoder blocks the canvas

`decodePng` is synchronous, so a large image freezes the canvas -- including
its IPC -- for the duration. The repository's 3384×2160 screenshot takes
about 36 ms, which is invisible; the 16-megapixel ceiling bounds the worst
case, but a file near it would stall a canvas for a noticeable moment and
make it briefly unable to answer a `ping` or a `close`. Not fixed, and it is
what defeated the race test above.

### Next: Kitty, then tmux passthrough, then Sixel last

The pipeline is now reachable end to end on the tier that works everywhere,
which was the point of doing it before any protocol. Each remaining tier is
a swap behind a working canvas rather than a leap of faith.

Kitty next: a base64 payload, and Ghostty reports as kitty so one
implementation covers both. Then tmux passthrough, which every protocol tier
needs and half-blocks does not. **Sixel last**, unchanged reasoning: it is
the only part that cannot be verified from here without `brew install
libsixel` for `sixel2png` as an independent oracle.

Open follow-ups, none blocking: `image` is not a dashboard region kind yet
(adding one means a case in `dashboard/validate.ts` and one in
`renderRegion`); the four primitives' inert `sentRef` reset; and the region
footer hint that still says "Esc: cancel" when Escape closes the whole
dashboard.
