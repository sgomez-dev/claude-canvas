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

## Known gaps

Nine were recorded when this ledger was first written. **All nine are now
closed**, each with the commit that closed it. They are listed in gap order;
the rulings are numbered in the order they were made, so they run out of
sequence here.

Anyone picking this up should read the roadmap's "Phase 3 — entry
conditions" next: the only item left there is verifying Sixel in Windows
Terminal, which was always Phase 3's own work.

### CLOSED 1 -- Outcomes are not buffered (commit 3d7dab5)

Was recorded as the most consequential open defect in the project, and
confirmed in a real tmux pane: a canvas broadcast its outcome to whoever was
connected at that instant and retained nothing, so a user who chose before
`wait` connected had the choice broadcast to zero connections, the canvas
exited, its record was deleted, and `wait` answered `no canvas <id>`. A
config error was effectively never observable by Claude for the same reason.

Fixed as sketched: the outcome is written synchronously into the registry
record before it is broadcast and before the canvas exits; `readRecord`
returns an outcome-bearing record even when the pid is dead, mirroring the
`lastError` precedent; the hook no longer deletes a record whose outcome is
unread; and `waitForOutcome` reads the record first, consumes it, and
re-checks after a failed connect or a mid-wait disconnect. `onAuthenticated`
(added in dc70a08 to de-flake a test) is what replays a retained outcome --
and `ready` -- to a controller that attaches later, which also makes `ready`
observable for the first time.

**Ruling 9: the first outcome wins.** A canvas has one answer. Letting a
later call overwrite it would let a controller read whichever of two
contradictory outcomes it happened to see, and the persisted copy could
disagree with the broadcast one. Concretely: a diff that fails to parse
reports the parse error, and a subsequent Escape does not replace it with
`cancelled`. Cost if wrong: a canvas that wants to revise its answer cannot,
which no canvas does.

**Ruling 10: `spawn` waits for reachability instead of returning when the
pane opens.** 10 s, against a measured 0-1 s window. A `spawn` that reports
success for a canvas nothing can reach is a lie the controller then trips
over. Cost if wrong: a false negative on a machine where a cold Bun start
exceeds 10 s, reported as an error naming the log file.

Contract change for anyone writing a controller: **the first frame received
is not necessarily the outcome.** `ready` arrives first. `waitForOutcome`
skips non-outcome frames; tests use the new `nextOutcome` helper.

### CLOSED 2 -- The scenario registry had no runtime consumer (commit bb182e2)

`getScenario` was called only from its own test, `registerScenario` and
`listScenarios` from nowhere, and `interactionMode` / `closeOn` /
`autoCloseDelay` / `defaultConfig` were read by nothing.

**Ruling 11: make the registry real rather than delete it.** Two consumers,
both of which pay for themselves:

- `--scenario` is validated against it. A shape-valid but nonexistent name
  used to pass straight through to a canvas that compared the string and
  silently rendered something else -- `--scenario meting-picker` got a
  read-only calendar, with nothing reported and `wait` answering `pending`
  55 s later.
- A new `scenarios [kind]` verb reports each scenario's `interactionMode`,
  which is how a controller learns whether to expect a result at all: a
  view-only scenario has no `selected` outcome, so its `wait` ending in
  `cancelled` is success.

`closeOn`, `autoCloseDelay` and `defaultConfig` were deleted instead, along
with the two generic parameters that existed only to type the last one.
Nothing read them, every canvas hardcodes its own closing behaviour and
defaults, and a field that describes behaviour without causing it reads as a
contract to whoever finds it next. Cost if wrong: reinstating one is a
three-line change.

Two defects fell out of doing this, both fixed here:

- **Every kind defaulted to `"display"`.** So `spawn flight` ran with
  scenario `"display"`, which flight does not have, and only worked because
  flight.tsx ignores the string -- the registry record then recorded a
  scenario that does not exist. `KIND_DEFAULT_SCENARIO` maps each kind to
  its own default, and a test pins the invariant that every default is
  registered and every registered kind is known, which is the drift that
  caused this.
- **The calendar's `display` scenario had no IPC server at all.** It never
  called `useCanvasServer`, so it wrote no registry record and could not be
  listed, read or closed: `close` answered "no canvas <id>" for a pane
  sitting right there, against the lifecycle design that requires closing to
  be an IPC request. It now has one, and `isMeetingPickerConfig` -- the type
  guard kept in c9b3c9e for exactly this -- replaces the inline
  `config?.calendars` truth test, so a meeting-picker request with a bad
  config reports an error instead of silently rendering a calendar the user
  cannot pick from.

### CLOSED 3 and 4 -- Dead code and duplicated types (commit c9b3c9e)

`markdown-renderer.tsx` deleted: 781 lines, nothing imported it. Deleting it
exposed `DocumentConfig.diffs` as a **documented feature nothing
implemented** -- only that renderer ever applied diff markers, while
skills/document/SKILL.md advertised diff highlighting with two worked
examples. Removed from the type and the skill, which now points at the
`diff` canvas.

Duplicated types resolved: the document types existed identically in two
files; `CalendarEvent` existed three times, two byte-identical and a third
with ISO **string** fields that was genuinely a different type sharing a
name, now `CalendarEventInput`. Net 885 deletions.

### CLOSED 5 -- The `update` message was unreachable (commit 06c7863)

`protocol.ts` defined it, `use-canvas-server.ts` exposed `onUpdate` and
`document.tsx` implemented it -- but there was no CLI verb, and none of the
four Phase 2 primitives implemented the callback. So live server-push, the
capability the roadmap cited when it chose TCP over files-plus-polling
("polling gives up server-push to the canvas — which live `update`
needs"), could not be invoked end to end at all.

Now: an `update <id>` verb taking `--config` or `--config-file`, a
`pushUpdate` on the controller side, and `onUpdate` wired into all four
primitives. Verified in a real pane -- a table's title and rows replaced in
place while it stayed open.

**Ruling 12: a pushed config resets the interaction state.** A new config is
a new question, and the state that referred to the old one is not merely
stale but dangerous: `form`'s values are keyed by field id and `diff`'s
decisions by hunk id, so an id reused across two configs would carry an
answer onto something the user never saw. The diff case is the sharpest --
same path plus same hunk index means the same id, so "approved" would
survive onto different code. Cursors and scroll offsets are reset for the
duller reason that they can point past the new content. Cost if wrong: a
controller that wants to append to a table has to re-send the whole thing,
which it does anyway since a config is replaced wholesale.

**Ruling 13: `pushUpdate` drains before closing.** `Connection.close()`
destroys the queued writer, discarding whatever the socket had not accepted
-- so without waiting for `flushed()` a config larger than one socket write
would be silently truncated, which is the same class of bug as 158e74a.
Covered by a test that pushes 3000 rows. Cost if wrong: an update takes as
long as the socket needs, which is the correct cost.

### CLOSED 6 -- `table` measured column width in UTF-16 code units (commit e08d447)

`String.length` was the wrong unit three ways: a CJK ideograph is one code
unit and two columns, an astral emoji two units and two columns, and a ZWJ
family emoji **eleven** units and two columns. Any row containing one of
them sheared apart.

**Ruling 14: no dependency was needed, only `Intl.Segmenter`.** The hard
half of the problem is grapheme clustering, and Bun has it built in --
verified before writing anything: it clusters a ZWJ family emoji, a
regional-indicator flag and a decomposed accent each as one segment. The
easy half is a width table for the cluster's leading code point, which is
~24 sorted ranges. So the phase constraint (no new runtime dependencies)
never had to be traded against correctness, and reaching into Ink's
transitive `string-width` was never necessary.

The range table is a deliberate practical subset of UAX #11 rather than a
generated implementation: the ranges a terminal actually renders
double-width, with East Asian *Ambiguous* treated as width 1, which is what
a terminal in a Latin locale does.

One limit is the domain's rather than the code's, and is now documented in
both `width.ts` and the table skill: a ZWJ sequence is one grapheme of two
columns by the emoji convention, but a terminal without ZWJ support draws
the components side by side and occupies more. No measurement can reconcile
those. Single-codepoint emoji, CJK and fullwidth forms -- what real table
data contains -- are unaffected.

13 unit tests, each asserting the old `.length` value alongside the correct
one so the defect stays legible, plus a render snapshot of a table whose
every row mixes widths.

### CLOSED 7 -- The calendar meeting-picker overflowed vertically (commit de5080b)

Both the pre- and post-fix baselines of `calendar meeting-picker renders`
showed the cyan cursor readout overwriting the start of the grey key hints.
The cause was one `Math.max`: a 6:00-22:00 day at 30-minute granularity is
32 slots, at 70x18 the vertical budget is 11 rows, and

    Math.max(1, Math.floor(availableHeight / totalSlots))

floors to 0 and is then forced to 1 -- so the grid rendered all 32 slots at
one row each into an 11-row box and Ink drew them over the help bar.

**Ruling 15: window the slots, the same way picker, diff and table do.** The
grid now shows as many slots as fit and pages when the cursor crosses a
boundary, with the footer naming the visible range. Every slot stays
reachable by navigation, and a pane roomy enough for all 32 keeps the old
behaviour of taller slots sharing out the spare rows. The alternative --
shrinking the day's hour range to fit -- would silently hide times the
caller asked for. Cost if wrong: the grid moves a window at a time instead
of scrolling smoothly.

The subtle half was the mouse. `terminalToSlot` maps a pixel row to a slot,
so it has to add the window offset as well; without that, clicking the top
of a paged grid books the slot at the same offset from the *start of the
day* rather than the one under the pointer. That is the worst outcome this
canvas has -- a silently wrong meeting time -- so it has its own test, which
was confirmed to fail with the offset removed: it booked 06:00 instead of
11:30.

Also removed: `cumulativeHeights`, computed on every render and read
nowhere. And the calendar skill now documents its keys, its paging, and its
config errors, none of which it mentioned at all.

### CLOSED 8 -- FrameDecoder was O(n^2) (commit 8f42921)

Phase 1's documented Phase 3 deferral. Now holds a chunk list and joins one
frame's bytes on completion. Measured old versus new: 4 MB in 16 KB chunks
41 ms -> 7 ms; 13 MB in 16 KB chunks 304 ms -> 22 ms. Across a 3.25x
increase in payload the old path grew 7.4x and the new one 3.1x -- quadratic
against linear.

### CLOSED 9 -- tmux never executed (commit b9b3ae8)

See the smoke test section below. Now `canvas/scripts/smoke.sh`, in the
repository and self-checking.

---

### Flaky test, found and fixed: `a large config survives the update path`

CI went red on ubuntu-latest for **27f8af2, a docs-only commit** -- which is
the tell that a test, not the code, was at fault.

The test pushed a ~600 KB config through `pushUpdate` and asserted on the
next frame after a single `r.settle()`. `pushUpdate` resolves when the bytes
reach the socket; the canvas still has to receive them, reassemble them
through `FrameDecoder` and re-render, which takes many event-loop turns at
that size, while `settle()` waits exactly one macrotask. So the assertion
held whenever the machine was idle and failed whenever it was not -- 30+
clean local runs, then red on a loaded runner.

The same shape as the timer-based races removed from the Phase 1 tests in
dc70a08, and the same mistake: asserting on a deadline instead of on a
condition.

**Ruling 17: assert on a condition, never on a fixed number of turns.**
A `settleUntil(r, predicate, timeoutMs)` helper re-renders until the frame
satisfies the predicate. All four `update` tests use it, not only the one
that failed -- the three small configs were equally racy in principle and
merely small enough to usually win. Verified 20 consecutive runs of that
file and 10 of the full suite, all clean. Cost if wrong: a genuinely broken
update now fails by timeout rather than immediately, which is slower to
diagnose but never wrong.

### Unresolved: one earlier unreproduced failure

Separate from the above, and still open. A single full-suite run reported
`1 fail` without naming the test, during the gap-2 work -- before
`update.test.tsx` existed, so it was not this one. 85 full-suite runs
immediately afterwards were clean, plus 10 more since. Recorded rather than
dismissed; if it recurs, capture the full output.

---

## End-to-end smoke test (`canvas/scripts/smoke.sh`)

The only thing in this repository that exercises the pane-opening path.
Everything else tests the IPC layer with no terminal at all -- which is what
the TCP transport was chosen to make possible -- so this is where a real
tmux split, a real Ink render, real keystrokes and the CLI's own `wait` meet.
tmux 3.7c, Bun 1.4.2. Self-checking; exits non-zero on failure.

**12 pass, 0 fail** as of the final run:

| Case | What it pins |
|---|---|
| `picker` | `j` `Enter` -> `{"selectedIds":["beta"]}` |
| `table` | `Escape` -> `{"cancelled","reason":"escape"}` |
| `form` | typed text, checkbox, submit -> per-type values |
| `diff` | `a` `Enter` -> one approved hunk decision |
| `calendar` meeting-picker | `Enter` -> a selected time slot |
| `calendar` display x3 | appears in `list`, answers `get`, is closable -- none of which worked before it had a server |
| invalid `--scenario` | rejected, rather than silently rendering another view |
| live `update` x2 | a table's title and rows replaced while its pane stayed open |
| retained outcome | a choice made with no controller attached still reaches `wait` |

Every pane closed itself by exiting 0 -- no orphaned panes, which is the
failure class the whole lifecycle design exists to prevent.

### Two bugs the script itself had, worth recording

Both were in the harness rather than the product, and both produced
convincing false results:

- `other_pane` took the first pane that was not the script's own. The
  meeting picker confirms for ~3 s before exiting, so its pane outlived its
  own `wait` and the next case sent keystrokes to it. Now the new pane is
  identified by diffing the pane list around the spawn.
- `spawn_pane` echoed an informational line to stdout, and callers capture
  its stdout as the pane id -- so `target` became two lines and every
  `send-keys` missed, turning five cases into `pending`. The echo goes to
  stderr, with a comment saying why.

## Windows-only failure after the gap-closing push (CI run 34276286536)

ubuntu and macos green, windows red, one test: `a config error reaches the
controller instead of being lost`, failing on `awaitRecord(id, 5000)`
returning null after the full 5 s.

Not a Windows quirk in the end -- a real race that only Windows' filesystem
timing exposed, and the strongest argument yet for the 3-OS matrix:

- Neither `Bun.write` nor `writeFileSync` is atomic, so a reader can observe
  a half-written record.
- `readRecord` **deleted** anything that failed to parse.

Together: a read that raced a write destroyed a good record, and nothing
ever rewrote it, so `awaitRecord` polled for a file its own first read had
unlinked. On macOS and Linux the write window was too narrow to hit; on
Windows it was not.

**Ruling 16: writes are atomic and reads are non-destructive.** Both halves,
not either. Records are written to a temp file and renamed into place --
rename replaces the destination atomically on POSIX and via
MOVEFILE_REPLACE_EXISTING on Windows -- and permissions are applied to the
temp file before it becomes visible under its real name, so a token is never
even briefly world-readable. `readRecord` no longer unlinks an unparseable
record: reading is not the place to destroy state. With atomic writes an
unparseable record means genuine corruption, and `listRecords` -- which runs
when nothing is mid-write -- prunes it, along with any temp file a crashed
write left behind.

Four tests: an unparseable record survives being read, `listRecords` prunes
it, `listRecords` cleans a stray temp file, and 60 interleaved
rewrite-then-read cycles never observe a partial record or leave a temp file.

*** PHASE 2 IMPLEMENTATION COMPLETE. Not reviewed by a second pass: this
ledger and the code in commits 158e74a..ddd263a are one agent's work with no
independent review round, unlike Phase 1's 18 task reviews plus a
whole-branch review plus a scoped re-review. A reviewer's first stop should
be the nine known gaps above, and gap 1 before the others. ***
