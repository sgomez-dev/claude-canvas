# SDD ledger — independent review of the unreviewed main merge, and Area 1's fix wave

**Spec/context:** this is not a normal plan execution. On 2026-09-08, a
different Claude Code session (not the one that wrote this ledger)
picked up this project's Phase 2 spec and plans
(`docs/superpowers/specs/2026-09-08-generic-primitives-design.md`,
`docs/superpowers/plans/2026-09-08-primitive-{diff,picker,form,table}.md`)
and, over 30 commits (`3ecb38b..8dd6d36`, merged directly to `main`),
completed all four Phase 2 primitives, fixed several real Phase 1
defects, and started Phase 3 (a dashboard/tree composition primitive)
plus plugin packaging work — 120 files, ~40k insertions. That session's
own ledger
(`docs/superpowers/2026-09-08-generic-primitives-progress.md`) ends
with an explicit admission: this work had **no second-pass independent
review**, unlike this project's own established process (Phase 1's 18
task reviews plus a whole-branch review plus a scoped re-review).

The controlling session (this one) was asked to be that missing review
round: four independent Opus-tier reviewers, each cold-started with no
visibility into the others' work, each checked out `origin/main` in
its own isolated worktree and empirically verified — not just read —
every claim in the other session's ledger, plus hunted for anything
not claimed. Scope split into four areas: (1) runtime/transport core,
(2) the four primitives, (3) scenario registry + CLI + calendar, (4)
Phase 3 start + build/bundle/CI.

## Cross-cutting result

All four reviewers independently converged on the same shape of
problem: **the other session's headline fixes are each substantively
real, but every one of them has an unfixed symmetric twin, an
incomplete edge case, or a test-coverage gap that lets a real
regression hide behind a green suite.** This is not "the merge is
bad" — `tsc` is clean, 293 tests passed, and the core designs (the
view/shell/validate split, atomic-rename registry, retained outcomes,
scenario-registry-as-real-consumer) are all architecturally sound.
It's that a single unreviewed pass, however careful, reliably misses
the second half of its own fixes — which is exactly why this project's
own process (a fresh review pass per unit of work) exists.

## Ranked findings (Critical/Important first; full detail per area below)

1. **[FIXED, Area 1] Outcome persistence silently EPERMs on Windows** —
   the platform this project is developed on could lose a user's
   result with no visible error, ever. Found from the committed test
   suite's own log output (8/8 clean runs).
2. **[FIXED, Area 1] Stale outcome cross-talk** — a deterministic
   `spawn` id (`${kind}-1`) could silently hand a *new* spawn the
   *previous* spawn's leftover answer.
3. **[OPEN, Area 2] The stale-closure-in-`useInput` bug this project
   fixed twice already (diff's `cursor`, this session's own picker/form
   fixes) is still live in ALL FOUR primitives on `main`**, despite
   code comments claiming otherwise — reproduced over real sockets:
   diff silently approves the wrong hunk, picker drops a multi-select
   toggle, form swallows a submit.
4. **[OPEN, Area 3] The calendar meeting-picker's own paging fix
   introduces a NEW silently-wrong-booked-time bug** on the last page
   via mouse hover — the exact failure class the fix exists to
   prevent, reintroduced by the fix itself.
5. **[OPEN, Area 3] Calendar's `display` scenario has the identical,
   UNFIXED overflow bug** the meeting-picker's own sibling fix closed
   — and the broken output is baked into a committed snapshot as the
   expected baseline.
6. **[OPEN, Area 2] `diff`/`table` crash into a raw React stack trace**
   on malformed config — reachable live via the `update` verb and via
   any dashboard region.
7. **[OPEN, Area 4] `check:standalone`'s "prove it" verification cannot
   fail on the bug it exists to catch** (Bun auto-install defeats it —
   proven by reintroducing the exact regression and watching the check
   still pass).
8. **[OPEN, Area 4] The dashboard's 11 own tests are provably blind to
   its own focus routing** (proven by breaking it live — all 11 stayed
   green); zero focus indicator exists at all; Tab collides with a
   composed Form's own field navigation.
9. **[OPEN, Area 3] `calendar display` never sends a cancel outcome on
   quit** — the only canvas of 8 that doesn't.

Plus a long tail of Important/Minor findings in every area — stale or
self-contradictory skill docs (found independently in 2 of 4 areas),
test suites not hermetic against the real machine-global registry
directory (found independently in 2 of 4 areas), assorted
`noUncheckedIndexedAccess`-adjacent gaps, dead code the other session's
own dead-code pass missed.

**Process finding, factual, not adjudicated here:** Phase 3
(dashboard/tree) was thinly pre-authorized by the roadmap (two
sentences plus one backlog bullet); the SAME unreviewed session wrote
its own Phase 3 design spec, its own "entry conditions," and
self-certified discharging them, then also did Phase 4-scoped work
(plugin packaging) as a self-authorized detour — honestly labeled
("Interlude") in its own ledger, but unscoped. Recorded for the
project owner's judgment.

---

# Area 1: runtime/transport core — FULLY RESOLVED

## Findings (independently verified against the other session's claims)

- **Claim "socket backpressure fixed" — confirmed real and
  load-bearing** (proven with a byte-fingerprint control experiment:
  9/12 4MB frames vanished with the fix reverted, 12/12 delivered
  byte-for-byte with it in place) — but Windows CI had zero actual
  regression coverage for it: a single Bun socket write on Windows
  loopback accepts up to ~15.9MB before ever backpressuring, so every
  committed large-frame test passed even with the fix fully reverted.
- **Claim "outcome durability fixed" — the persistence half did NOT
  work on Windows.** Proven from the committed suite's own log output,
  not inferred: `EPERM: operation not permitted, rename` in 8/8 clean
  runs. Root cause: Windows `rename` fails when the destination is
  held open by a concurrent reader — and the reader is this project's
  own polling code. The failure was swallowed to a log file nobody
  reads. Tests stayed green because an in-memory replay covered for
  the broken disk path while the canvas was still mounted — a
  textbook "green suite, broken feature."
- **Claim "atomic writes fixed" — atomicity itself real** (2125
  concurrent reads / 400 rewrites: zero partial/unparseable) **but it
  was the direct cause of the Windows EPERM failure above**, and the
  "token never briefly world-readable" claim was false as stated (the
  window moved from the real path to the temp path, same duration).
- **A second, previously-unknown Critical:** a stale, unconsumed
  outcome from an earlier `spawn` of the same deterministic id was
  silently handed to a later `spawn` invocation — reproduced directly
  (returns in ~1ms).
- FrameDecoder's O(n) fix: confirmed correct, real linear scaling
  measured.
- Nine further Important findings: outcome TTL measured from the wrong
  timestamp; consuming a live outcome deleted a still-running canvas's
  record; an unbounded queued writer with no backpressure; colliding
  temp file paths under concurrent same-id writes; fixed-deadline
  sleeps causing measured real flakiness under CPU load (7-9
  failures/run); a permissions-window claim that didn't hold; tests
  mutating the developer's real global registry directory.

## Fix wave (Sonnet implementer)

All 9 items fixed in 5 commits on `fix/2026-09-09-merge-review-findings`
(forked from `origin/main`@`8dd6d36`), each with differential proof
(bug reproduced on the original code, confirmed fixed after) for the
two Criticals specifically. `bun test`: 306 pass / 1 skip (a
Windows-only permission-bits test, expected) / 0 fail, run 5+ times
including under CPU load, 0 flakes.

## Scoped re-review (Opus)

Independently re-verified all 9 fixes from scratch (own probes, not
trusting the implementer's numbers). 6 of 9 fully confirmed outright.
Three needed another look, each precisely diagnosed:

- The retry budget guarding the Windows rename fix (~190ms) covered
  the implementer's own test shape but failed against realistic
  contention (antivirus/backup/indexer agents holding a handle
  250-800ms) — reproduced.
- The cleanup meant to delete a live canvas's now-consumed-outcome
  record before exit was an unawaited floating promise that never
  actually got to run before the CLI's `process.exit(0)` — reproduced
  5/5 runs, a genuine (if lower-severity) regression traded for the
  correctness fix it shipped alongside.
- The "0 flakes under CPU load" claim for the sleep→condition-polling
  conversion was false — reproduced 7/10 failed runs, with two
  precisely pinpointed one-line causes (one leftover fixed sleep, one
  poll waiting on the wrong side of a round trip).

## Surgical patch (adjudicated, not a second full fix-wave cycle)

All 3 residuals closed in 2 more commits, each with its own
before/after evidence (the retry budget widened specifically on the
synchronous/exiting-process path to ~3s since that caller costs
nothing by waiting longer; the cleanup made genuinely synchronous;
both pinpointed test bugs fixed, reproduced 6/10 failures pre-patch →
10/10 clean post-patch across two verification passes).

## Final state

Branch `fix/2026-09-09-merge-review-findings`, 7 commits
(`3427c22`..`570f673`), merged to `main`. `bun test`: 306 pass / 1
expected skip / 0 fail. `bun x tsc --noEmit`: 0 errors.

---

# Areas 2, 3, 4 — REVIEWED, findings recorded, NOT YET FIXED

These three areas' full findings are recorded above in the "Ranked
findings" section and in this session's working ledger. Summary of
what remains open, to be picked up next:

## Area 2 (the four primitives) — next up

Headline: the stale-closure `useInput` bug is live in all four
primitives (Critical); `diff`/`table` crash on malformed config
instead of erroring (Important); `diff`'s viewport math is off by one
and its scroll offset is unclamped; `table`'s width fix has a real gap
for the U+2600–U+2BFF emoji block (the single most likely emoji in an
LLM-generated status table) despite its own skill doc claiming emoji
"align correctly"; `form` violates its own declared min/max on the
wire for a blank optional number field and doesn't window its
textarea; all four primitives (plus the calendar) break on footer-wrap
at narrow terminal widths. The `hunkId`-collision fix is real but
narrower than described (rejects rather than disambiguates duplicate
paths — a real `git log -p` shape is now a hard error, honestly
documented). `picker`'s `mode` field was resolved by making it
strictly required rather than defaulted, a breaking change for old
callers, but internally consistent (type/runtime/docs now agree).

## Area 3 (scenario registry, CLI, calendar) — after Area 2

Headline: the calendar meeting-picker's own overflow/mouse-mapping fix
(Ruling 15) is correct on its own terms but introduces a new
last-page-hover mis-booking bug, and its sibling `display` scenario has
the identical unfixed overflow bug with a snapshot baking in the
broken output. `calendar display` never sends a cancel outcome.
`isMeetingPickerConfig` accepts an empty `calendars` array despite its
own error message forbidding it. Several skill docs contradict
themselves or each other (document's diff-highlighting claim, two
different key-binding descriptions for the calendar, a stale `onGet`
claim). The scenario registry and `KIND_DEFAULT_SCENARIO` fixes
themselves are solid, verified via source mutation to prove the drift
test is genuinely dynamic.

## Area 4 (Phase 3 start + build/bundle/CI) — after Area 3

Headline: `check:standalone`'s verification is provably unable to
catch the regression it exists to catch (Bun auto-install defeats it).
The dashboard's focus routing works correctly in isolation but has
zero real test coverage of that fact (11 tests, all green with focus
routing broken); no focus indicator exists at all; Tab collides with a
composed Form's own internal navigation; a `text` region ignores its
row budget entirely. The tree view is the best-engineered new code in
the whole merge — validated end-to-end, sound `noUncheckedIndexedAccess`
handling, genuinely discriminating tests. CI's 3-OS matrix and the
line-ending fix are both genuinely correct, verified under the hostile
`core.autocrlf=true` configuration. The README overclaims smoke-test
coverage (states "all eight canvas kinds," the script actually
exercises six). The `canvas`/`canvas` command-name collision from the
roadmap's own documented issue remains unresolved, and the surviving
duplicate has a stale description missing three of the eight canvas
kinds.
