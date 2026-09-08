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

Nine were recorded when this ledger was first written. Six are closed; the
status of each is below, newest work first. **A reader picking this up
should start with the three still open.**

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

### CLOSED 2 -- The scenario registry had no runtime consumer (this commit)

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

### CLOSED 5 -- The `update` message was unreachable (this commit)

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

### STILL OPEN 6 -- `table` measures column width in UTF-16 code units

CJK and emoji cells misalign their row. The fix needs a display-width
measure; the phase constraint is no new runtime dependencies, and reaching
into Ink's transitive `string-width` is worse than the misalignment.
`Intl.Segmenter` is built into Bun and would give correct grapheme
clustering without a dependency, which is the route to take.

### STILL OPEN 7 -- The calendar meeting-picker's help bar overlaps its readout at 70x18

Both the pre- and post-fix baselines of `calendar meeting-picker renders`
show the cyan time text overwriting the start of the grey hint line -- a
vertical overflow artifact, unrelated to the locale and 24-hour fixes that
touched those lines. The grid renders a fixed number of hours regardless of
the terminal height; making it fit is the fix.

### Unresolved, not a gap: one unreproduced test failure

A single full-suite run reported `1 fail` without naming the test, between
the gap-2 code and its documentation. 85 subsequent full-suite runs were
clean (15 + 30 immediately after, plus 25 runtime-only and the 15 before).
Recorded rather than dismissed: cross-file interference through the real
user data directory is plausible in principle, since several test files
write registry records concurrently, though `cli.test.ts`'s `list` test uses
`toContain` rather than an exact match and the new outcome tests scope
themselves to their own ids. If it recurs, capture the full output -- the
runs above were re-run with output saved for exactly that reason and it did
not reappear.

---

## End-to-end smoke test (2026-09-08, tmux 3.7c, Bun 1.4.2)

The first execution of the pane-opening path on any real machine. Each
primitive was spawned into a real tmux pane, its rendered frame captured
with `capture-pane`, driven with `send-keys`, and its outcome read back
through the CLI's own `wait`. `wait` was started before the keys were sent,
which is the ordering the canvas skill now tells Claude to use.

| Primitive | Keys sent | `wait` returned |
|---|---|---|
| `picker` | `j` `Enter` | `{"status":"selected","data":{"selectedIds":["beta"]}}` |
| `table` | `Escape` | `{"status":"cancelled","reason":"escape"}` |
| `form` | `h` `i` `Tab` `Space` `Tab` `Enter` | `{"status":"selected","data":{"values":{"who":"hi","ok":true}}}` |
| `diff` | `a` `Enter` | `{"status":"selected","data":{"decisions":[{"hunkId":"x.txt#0","decision":"approved"}]}}` |

4 pass, 0 fail. Every frame rendered legibly at 120 columns, `spawn`
reported `"host":"tmux"`, and every pane closed itself by exiting 0 -- no
orphaned panes, which is the failure class the whole lifecycle design exists
to prevent.

### Found by the smoke test, and fixed

**An empty text/textarea/number field rendered no input line at all.** The
form pane showed:

```
> Who *
  Confirmed
  [ ]
```

The focused `Who` field had a label and nothing beneath it: an empty value
with no `placeholder` rendered an empty `<Text>` that collapsed to nothing,
so the user was typing into a field with no visible extent. A `placeholder`
masks it, and every snapshot fixture gave its textarea one, which is exactly
why no test caught it. This is the case for driving a real pane -- 212 unit
and integration tests did not surface it, and one `capture-pane` did.

Fixed: a field always renders with visible extent. The cursor `▏` sits where
the next character will land, so it follows the typed text and marks the
focused field; an unfocused empty field falls back to a dim `—`. Verified
back in a real pane, where the same form now shows:

```
> Who *
  ▏
  Confirmed
  [ ]
```

**Ruling 7: the cursor marks focus in addition to the `> ` gutter and the
label colour, not instead of them.** The gutter already survives a no-color
terminal (picker.tsx's precedent), so the cursor is redundant as a focus
indicator -- but it is not redundant as an *extent* indicator, which is the
actual defect. Cost if wrong: one glyph per focused field.

---

## Post-push CI failure and its fix (run 34271005232)

The first push went green on all three legs (run 34270256655 — the first
green run this repository has ever had). The second push failed on
**macos-latest only**, with ubuntu and windows passing:

```
(fail) waitForOutcome resolves cancelled [2037.10ms]
211 pass, 1 fail
```

Not a regression from the pushed commits. A latent race in a Phase 1 test
(Task 7, `client.test.ts`), surfaced by scheduling luck:

`server.broadcast` only reaches connections that are **already
authenticated** —

```ts
broadcast(msg) { for (const [socket, state] of conns) if (state.authed) send(socket, msg); }
```

— and the test broadcast on a fixed 30 ms timer while `waitForOutcome` was
still doing a TCP connect, a filesystem read of the registry record, and the
hello round trip. When the timer wins, the message is dropped silently and
the wait runs to its full 2000 ms timeout, which is exactly the 2037 ms in
the log. The sibling `waitForOutcome resolves selected` test has the
identical shape and merely won the race that day; `integration.test.ts` had
a third instance on a 40 ms timer.

**Ruling 8: fixed by removing the guess, not by lengthening it.** A longer
timer lowers the failure rate without eliminating it and slows the suite,
and this repository has already paid for that lesson once (6a14420, "remove
timing-dependent flakiness in two tests"). `CanvasServerOptions` gains
`onAuthenticated(reply)`, called immediately after `hello-ok` with a reply
bound to that one connection, so all three tests now send at the exact
moment the handshake completes and contain no sleep at all. Verified with 25
consecutive runs of the runtime suite: 0 failures.

This hook is not test-only scaffolding. It is precisely what gap 1's fix
needs — the server previously had no way to tell anyone that a controller
had attached, which is the root cause of `sendError` being broadcast to zero
connections. Nothing in production wires it yet; three tests cover it
(fires after hello-ok and in that order, does not fire for a failed
handshake, and a throwing callback is routed to onError while the connection
survives — a canvas must always be able to exit 0).

The other four broadcast call sites in the tests were checked and are safe:
each follows an awaited `openConnection`, which resolves only after
`hello-ok`.

*** PHASE 2 IMPLEMENTATION COMPLETE. Not reviewed by a second pass: this
ledger and the code in commits 158e74a..ddd263a are one agent's work with no
independent review round, unlike Phase 1's 18 task reviews plus a
whole-branch review plus a scoped re-review. A reviewer's first stop should
be the nine known gaps above, and gap 1 before the others. ***
