# SDD ledger — Phase 2, generic primitives

Spec: docs/superpowers/specs/2026-09-08-generic-primitives-design.md (read, reachable)
Plans: docs/superpowers/plans/2026-09-08-primitive-{diff,picker,form,table}.md
Branches: origin/worktree-phase2-primitives (diff, picker, orphan form) → merged to main 2026-09-08
Bun 1.4.2 (macOS arm64), matching the CI matrix's pinned version.

This ledger is written **after the fact**. Phase 1 kept a ledger from its
first task; Phase 2 did not, and the cost is recorded in the audit below --
21 commits landed with no record of what was reviewed, what was decided, or
what was known to be missing, and three of those commits describe work they
do not contain.

---

## Audit of the inherited state (2026-09-08)

### What the branches actually contained

| Primitive | Component | Wired (KNOWN_KINDS / registry / dispatch) | Tests | Verdict |
|---|---|---|---|---|
| `diff` | 203 lines + 204-line parser | yes / yes / yes | 13 parser, 5 snapshot, 9 IPC | complete |
| `picker` | 242 lines | yes / yes / yes | 4 snapshot, 6 IPC | complete |
| `form` | 254 lines | **no / no / no** | **none** | orphaned, unreachable |
| `table` | **absent** | — | — | **did not exist** |

### Commit messages that describe work they do not contain

- `bed7056` "feat(table): implement Table primitive with view-only
  scrolling functionality", listing a component, a scenario, CLI wiring,
  snapshots and an IPC test. Contains five markdown files and no code.
- `3ecb38b` (main's HEAD before the merge) "feat(picker): implement Picker
  canvas component… feat(table): implement Table canvas component".
  Contains four markdown files and no code.
- `33e5caa` "feat(form): Form canvas component with 5 field types and
  validation". Contains the component, and neither the validation the
  subject claims nor any of the plan's remaining three tasks.

Recorded because a history that claims work it does not contain is worse
than an incomplete history: the next reader trusts it. Rewriting these three
subjects needs a force-push to a shared branch and is the repository
owner's call, not this pass's.

### CI had never been green

Both CI runs on `main` were `failure`, including run 34216025548 for
`489b2bf`, the commit whose own message declares Phase 1's "final review,
fix wave, and its re-review all clean" and whose ledger records "124
pass/0 fail". Two distinct defects, neither introduced by Phase 2:

1. **Frames larger than the socket send buffer were silently truncated.**
   `Bun.Socket.write()` is documented as unbuffered and non-blocking: it
   returns fewer bytes than offered under backpressure, and -1 once closed.
   `server.ts` and `client.ts` both discarded the return value. Measured
   here: a 4,000,000-byte write returned 327,212, and the peer received
   exactly 327,212. Failed on ubuntu-latest and macos-latest; **passed on
   windows-latest**, whose loopback send buffers absorb 4 MB in one call --
   which is why it was invisible on the machine the code was written on.
   Fixed in 158e74a with a drain-aware queued writer, 11 unit tests, and a
   new integration test for the canvas→controller direction that had no
   large-frame coverage at all. Both large-frame tests were confirmed to
   fail with the fix reverted.
2. **A locale-dependent snapshot.** `meeting-picker-view.tsx` formatted its
   readout with `toLocaleTimeString([], …)`. `[]` means "whatever the
   runtime resolves", and Bun resolves it from the host: `en-US` on
   macOS/Linux, the OS regional settings on Windows. The committed baseline
   held the 24-hour rendering of the author's machine, so it matched no CI
   leg -- not even windows-latest, whose regional settings are en-US.
   Fixed in a8e9b4b with an explicit locale at the call site.

**Ruling 1: LANG/LC_ALL cannot fix a locale-dependent render, so do not try.**
Measured with `LC_ALL` set to each of `en_US.UTF-8`, `en_GB.UTF-8`,
`es_ES.UTF-8` and `C`: Bun's `Intl` default locale stayed `en-US` on macOS.
An explicit locale at each call site is the only defence. Written into
`test/setup.ts` beside its TZ pin so the next person to hit this does not
spend the same hour. Cost if wrong: none; the pin is strictly narrower than
the previous behaviour.

**Ruling 2: `en-US`, not 24-hour, for the calendar readout.** Chosen for
consistency with `flight/types.ts` and `flight/components/cyberpunk-header.tsx`,
which already hardcode `en-US`. 24-hour would render two characters shorter
and is arguably better for a scheduling UI, but that is a product choice and
this pass was fixing a determinism defect. One line (`hour12: false`) if the
owner prefers it. Cost if wrong: one line and one regenerated baseline.

---

## Work completed in this pass

| # | Commit | Content |
|---|---|---|
| 1 | db778ad | merge origin/worktree-phase2-primitives → main |
| 2 | 158e74a | socket backpressure fix (Phase 1 defect) |
| 3 | a8e9b4b | locale pin (Phase 1 defect) |
| 4 | 792f975 | `form` wired, plus three of its defects |
| 5 | 6b2357a | `table` implemented from scratch |
| 6 | 7f0b037 | `diff`/`picker` viewports and three correctness fixes |
| 7 | ddd263a | four SKILL.md files and honest caveats |
| 8 | this | ledger and roadmap status |

Final state: `bun test` 211 pass / 0 fail, 22 snapshots; `bun x tsc --noEmit`
clean; all three CI steps run locally against Bun 1.4.2.

### Defects found by reading the inherited code

`form` (all three fixed in 792f975):

- No `submittedRef` guard, which `picker` and `diff` both have. Enter on
  Submit followed by Escape sent **both** `selected` and `cancelled`.
- No config validation and no `sendError`, against the spec's explicit rule
  for an empty `select`. A bad config opened a canvas that could not be
  completed and answered a bare `pending` 55 s later.
- **NaN reached the wire.** A lone `-`, typed on the way to `-5`, survived
  `clampNumber` untouched, hit `Number()` at submit, and `JSON.stringify`
  serialized it to `null` -- for a *required* field, which is precisely the
  silent incomplete submit the spec forbids.

`diff` and `picker` (fixed in 7f0b037):

- Neither windowed its content. A 200-line hunk or a 25-option list
  overflowed the pane and pushed out the rows that carry the state: diff's
  `[undecided]` marker, picker's cursor, both footer hints.
- A binary-only diff rendered "Nothing to review." and never named the file,
  against the spec's "shown as a label".
- `hunkId` is `${newPath}#${index}`, so two file blocks sharing a `newPath`
  minted colliding ids whose decisions overwrote each other.
- `picker`'s `mode` was declared required but accepted as absent and
  defaulted to `"single"`.

`parser.ts`, not fixed, recorded:

- The comment at `splitIntoFileBlocks` claims a `--- `/`+++ ` pair "is only
  ever a file header, never accidental diff-body content". That is false for
  a context line in a diff-of-a-diff whose leading space has been stripped.
  Narrow enough to leave; the comment overstates its guarantee.
- `git diff --no-prefix` is not parseable (`OLD_PATH_RE` requires `a/`).
  Documented in `skills/diff/SKILL.md` rather than supported.

---

## Rulings

**Ruling 3: `table` follows its plan's component design, but not its
omissions.** The plan's code had no config validation, no `sendError` and no
`submittedRef`. Adding all three matches `picker` and `form`, and without
validation a missing `columns` renders rows into nothing -- a frame that
looks exactly like the bug the spec's "an empty table must never look like a
bug" rule exists to prevent. Cost if wrong: three guards nothing exercises.

**Ruling 4: a duplicate file path in a diff is rejected, not disambiguated.**
Minting `${fileIndex}:${path}#${n}` ids would deviate from the spec's stated
id format for every diff in order to serve one malformed input. git never
emits the same file twice; two concatenated diffs do, and there is no
correct reading of "approve hunk 0 of x" when x appears twice with different
content. Cost if wrong: a caller who deliberately concatenates diffs must
review them one at a time, which the error message says.

**Ruling 5: both viewports page, and derive the window from the cursor
during render.** A `scrollOffset` in state needs an effect to track the
cursor, which costs a render per keystroke and lands one render after the
hunk it belongs to was drawn at the old offset. Paging rather than centring
means the view moves only when the cursor crosses a boundary instead of
shifting under the reader on every keypress. Cost if wrong: the view jumps a
window at a time rather than scrolling smoothly.

**Ruling 6: the four missing SKILL.md files document limitations, not just
config.** The spec's success criteria include Claude reaching for a canvas
on its own initiative, and a skill that lists fields but never says when the
primitive earns its keep cannot cause that. Each file therefore leads with
"when to reach for this" and states plainly what the primitive will not do.

---

## Known gaps, deliberately not closed in this pass

**1. Outcomes are not buffered. This is the most consequential open defect.**

A canvas sends `selected`/`cancelled`/`error` by broadcasting to whoever is
connected at that instant, and retains nothing. Three consequences:

- An outcome produced before the controller's `wait` connects is broadcast
  to zero connections and lost. The canvas then exits and its record is
  deleted, so the follow-up `wait` answers `no canvas <id>` and the user's
  choice is unrecoverable. `calendar` and `flight` implement no `onGet`, so
  there is no fallback path either.
- A **config error is effectively never observable by Claude.** `diff`,
  `picker`, `form` and `table` all gate `sendError` on `ipc.isConnected`,
  which reports that the canvas's own server came up -- not that a
  controller attached. A controller can only learn the port from the
  registry record, which the server writes as it starts. So the error is
  always already broadcast by the time `wait` connects. This is why none of
  the four has an end-to-end test for its `sendError` path; the omission was
  inherited, and `test/integration/form.test.tsx` now states it explicitly
  rather than leaving it to be rediscovered.
- `spawn` returns as soon as the pane opens, which can precede the canvas
  writing its record, so an immediate `wait` can answer `no canvas <id>`
  even when nothing is wrong. `openConnection` has no retry.

Sketch of the fix, for whoever takes it: persist the outcome into the
registry record before exiting and have `waitForOutcome` consume it there,
mirroring the `lastError` precedent that `readRecord` already honours ahead
of its liveness check. That makes the documented `spawn` → `wait` flow
correct regardless of timing, and makes `sendError` testable. Out of scope
here because it changes the record shape, the client's wait semantics and
the record lifecycle at once, and it was not in the agreed scope for this
pass.

**2. The scenario registry has no runtime consumer.** `getScenario` is
called only from its own test; `registerScenario` and `listScenarios` are
called from nowhere; `interactionMode`, `closeOn` and `autoCloseDelay` are
read by nothing -- each primitive hardcodes its own behaviour. So Phase 1's
finding #3 ("the flight canvas is not in the registry") was closed by adding
an entry with no functional effect, and `registry.test.ts` asserts the
presence of entries nothing reads.

Consequence today: `--scenario` is validated for identifier shape only,
never against the registry. `calendar.tsx:354` reads
`scenario === "meeting-picker" && config?.calendars`, so a typo'd scenario
name, or a correct one with a config missing `calendars`, silently falls
through to the read-only view -- the user sees a calendar they cannot pick
from, and `wait` answers `pending` 55 s later with no indication anything
was wrong. Phase 2 registered four more scenarios into the same dead
registry because the spec told it to follow the `flight:booking` pattern.

Decide before Phase 3 whether the registry becomes real (the CLI validates
`--scenario` against it and reads `closeOn`/`autoCloseDelay`) or is deleted.
Registering more scenarios into it is bookkeeping either way.

**3. `markdown-renderer.tsx` is 781 lines of dead code**, the largest file
in the repository and roughly a tenth of it. Nothing imports it; `document.tsx`
uses `raw-markdown-renderer.tsx`. Phase 1 spent commit 2ad2fa0 fixing its
`noUncheckedIndexedAccess` violations. The final whole-branch review already
recommended deleting it. Still here.

**4. Duplicated type definitions.** `DocumentConfig`, `DocumentDiff` and
`DocumentSelection` are defined identically in `scenarios/types.ts` and
`canvases/document/types.ts`; `CalendarEvent` in three places
(`calendar.tsx`, `calendar/types.ts`, `scenarios/types.ts`). The components
import the `canvases/` copies, so the `scenarios/types.ts` ones are unused
duplicates waiting to diverge.

**5. The `update` message is unreachable.** `protocol.ts` defines it,
`use-canvas-server.ts` exposes `onUpdate`, and `document.tsx` implements it
-- but **the CLI has no `update` verb** (`show`, `spawn`, `wait`, `get`,
`close`, `list`, `env`). The roadmap chose TCP over files-plus-polling
specifically because polling "gives up server-push to the canvas — which
live `update` needs"; the feature that decided the transport has no way to
be invoked. Neither `diff`, `picker`, `form` nor `table` implements
`onUpdate`, which costs nothing until the verb exists.

**6. `table` measures column width in UTF-16 code units**, so CJK and emoji
cells misalign their row. The fix needs a display-width measure; this
phase's constraint is no new runtime dependencies, and reaching into Ink's
transitive `string-width` is worse than the misalignment. Documented in
`skills/table/SKILL.md`.

**7. The calendar meeting-picker's help bar overlaps its readout at 70×18.**
Both the pre- and post-fix baselines of `calendar meeting-picker renders`
show the cyan time text overwriting the start of the grey hint line -- a
vertical overflow artifact, present before this pass and unrelated to the
locale fix. Left alone: the fix is a layout change to a Phase 1 canvas, and
the snapshot's job here was to become deterministic.

**8. `FrameDecoder` still re-concatenates its whole buffer per chunk**,
Phase 1's documented Phase 3 deferral. Measured during this pass, so the
figure is now real rather than estimated: a 4 MB frame in 16 KB chunks costs
39 ms, in 64 KB chunks 15 ms. Not the reason the 4 MB test was failing --
that was the truncation above -- and not urgent at these numbers, but the
new `socket-writer.ts` deliberately avoids the same pattern on the outbound
side by queueing views rather than one growing buffer.

**9. `tmux split-window` has still never been executed on a real machine.**
Phase 1 recorded this as analysis-only and judged it safe; it remains so.
No tmux on this pass's machine either, so every test here runs the IPC layer
with no terminal at all -- which is exactly what the TCP transport was
chosen to make possible, but it means the pane-opening path is the one thing
in this repository with no execution behind it.

---

## Spec success criteria, closed out

| Criterion | State |
|---|---|
| Each primitive spawns via the existing CLI with the four kinds added to `KNOWN_KINDS` | met — verified by invoking all seven kinds and a typo |
| Each renders with a byte-stable snapshot test | met — 22 snapshots |
| `diff`'s parser recovers structure from real `git diff` output | met — 15 parser tests |
| `picker` supports single and multi from one implementation | met |
| `form` supports all five field types | met |
| `table` renders scrollable tabular data with no selection concept | met |
| No new runtime dependencies | met — dependency list unchanged |
| A `skills/<kind>/SKILL.md` per primitive | met |

Non-goals held: nothing here composes primitives into a domain canvas, no
image rendering, no row selection inside `table`, no field types beyond the
five approved.

The one success criterion the spec itself scoped out remains out: "making
Claude actually choose to open these unprompted" is a prompting concern, and
the four new SKILL.md files are the whole of what this pass can do about it.

*** PHASE 2 IMPLEMENTATION COMPLETE. Not reviewed by a second pass: this
ledger and the code in commits 158e74a..ddd263a are one agent's work with no
independent review round, unlike Phase 1's 18 task reviews plus a
whole-branch review plus a scoped re-review. A reviewer's first stop should
be the nine known gaps above, and gap 1 before the others. ***
