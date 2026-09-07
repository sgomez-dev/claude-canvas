# SDD ledger — plan: docs/superpowers/plans/2026-09-07-canvas-foundations.md

Spec: docs/superpowers/specs/2026-09-07-canvas-foundations-design.md (read, reachable)
Worktree: .claude/worktrees/canvas-foundations, branch worktree-canvas-foundations
Baseline at 2d45bcc: 0 test files, 113 `tsc --noEmit` errors — matches the spec's stated figure.
Bun 1.4.2 at %LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_...\bun-windows-x64\bun.exe (not on PATH)

## Pre-flight conflict scan

### Cross-task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T1 ↔ T13 | snapshot tests pass `socketPath={undefined}` → T13 renames the prop to `enabled` | Handled: T13 Step 3 updates the test in the same task. OK |
| T1 ↔ T11 | `renderCanvas` harness → hook test | OK |
| T1 ↔ T16 | baseline snapshots → guard for the ~97 type edits | Dependency direction correct (T1 first). OK |
| T2 ↔ T5 | `recordPath`, `canvasesDir` | OK |
| T2 ↔ T11 | `logPath` | OK |
| T2 ↔ T12 | `configPath` | OK |
| T3 ↔ T5 | `assertIdent` guards record ids | OK |
| T3 ↔ T10 | whitelist + wt semicolon guard | Deliberate defence in depth, not duplication. OK |
| T3 ↔ T12 | `assertIdent` at the CLI boundary | OK |
| T4 ↔ T6, T7 | `encodeFrame`, `FrameDecoder`, message types | OK |
| T5 ↔ T6 | `newToken` imported by server.ts from registry.ts | **FINDING 1** — layering inversion, ruled below |
| T5 ↔ T7 | `readRecord` | OK |
| T5 ↔ T11 | `writeRecord`, `deleteRecord` | OK |
| T6 ↔ T7 | server/client over TCP | OK |
| T6 ↔ T11 | `startCanvasServer` | OK |
| T8 ↔ T9, T10 | `host/types.ts` leaf, backends import types not index | Cycle already removed during planning. OK |
| T8 ↔ T11, T12 | `detectHost` | OK |
| T11 ↔ T13 | `useCanvasServer` → three canvases | OK |
| T12 ↔ T13 | `renderCanvas(kind, id, config, {scenario, enabled})` | Signatures agree. OK |
| T13 ↔ T14 | `hooks/index.ts` vs `use-mouse.ts` | Different files. OK |
| T13 ↔ T17 | T13 deletes `src/api/`, T17 removes its references | Order correct (T13 first). OK |
| T13 ↔ T15, T16 | T13 edits the canvases, T15/T16 fix their types afterwards | Order correct. OK |
| T14 ↔ T16 | both touch `use-mouse.ts` and `document.tsx` | T16 Step 1 re-lists errors per file, so shifted line numbers are self-correcting. OK |
| T15 ↔ T16 | both touch `calendar.tsx` | **FINDING 2** — expected error counts do not add up, ruled below |
| T18 ↔ T15, T16 | CI gates on `tsc --noEmit` clean | Only reachable after T16; T18 is last. OK |

### Per-task internal agreement

| Task | Finding |
|---|---|
| T1 | Tests use `socketPath={undefined}`; both current hooks early-return on a falsy socket path (verified at `use-ipc-server.ts:44`, `use-ipc.ts:37`). Agrees. |
| T2 | Tests assert absolute path, no `/tmp`, distinct config/record paths — all satisfied by the implementation shown. Agrees. |
| T3 | 22 cases against one regex; `;` present as required by the spec. Agrees. |
| T4 | 8 cases; ceiling checked before allocation, matching the stated intent. Agrees. |
| T5 | `t-err` uses a live pid and the implementation returns early on `lastError` before the liveness check, so the test passes for the stated reason. `assertIdent` throwing inside an async function yields a rejected promise, which is what the invalid-id test expects. Agrees. |
| T6 | `talk` helper drives the same socket API the implementation uses. Agrees. |
| T7 | `openConnection` sends `hello` then awaits `next`; the inbox buffers a reply that lands before the waiter, so the handshake cannot race. Agrees. |
| T8 | Split into `types.ts` + `index.ts`; the ordering dependency on T9/T10 is stated in Step 4. Agrees. |
| T9 | argv assertions match the built array, including `-l` not `-p`. Agrees. |
| T10 | Asserts `-w 0`, `-V`, `--size`, and the semicolon refusal. Agrees. |
| T11 | Tests cover only the `enabled: false` path; server behaviour is covered by T6/T7, as the task states. Agrees. |
| T12 | `import.meta.main` guard makes the module importable by its own test. Agrees. |
| T13 | Migration order document → flight → calendar matches the spec. Agrees. |
| T14 | `withMouseTracking` tests assert the `finally` path. Agrees. |
| T15 | See Finding 2. |
| T16 | Ten files, ascending error count, commit per file, snapshots after each. Agrees. |
| T17 | Deletion verified by a `grep` whose expected output is stated. Agrees. |
| T18 | `--frozen-lockfile` requires a committed lockfile, which exists as of 2d45bcc. Agrees. |

### Rulings

Ruling 1: `newToken` moves from `registry.ts` to a new leaf module `canvas/src/runtime/token.ts`, imported by both `registry.ts` and `server.ts` — why: as written, `server.ts` imports `newToken` from `registry.ts`, so the transport layer depends on the storage layer and transitively drags in `paths.ts` and `validate.ts` merely to get a random hex string. That is a layering inversion, and the spec places the token with the transport's authentication concern, not with the registry. A 6-line leaf module removes it. Cost if wrong: one extra trivial file, and T5/T6 import lines differ from the plan text.

Ruling 2: T15 Step 3 expects **97** remaining errors, not 100, and T16's "~98" is exactly **97** — why: the plan's arithmetic assumed 113 as the starting point for T15, but T13 deletes `src/api/` first, which removes its 3 errors. So the real sequence is 113 → 110 after T13 → 97 after T15's 13 JSX fixes → 0 after T16. The spec's "~98" was approximate and off by one; 97 is the verified figure (per-file counts sum to 113 with `api/canvas-api.ts` contributing 3, and none of the 13 TS2503 errors are in that file). Cost if wrong: an implementer stops on a count mismatch that is not a real defect, costing one clarifying round.

Both rulings applied to the plan text before Task 1 was dispatched, and
committed as c5f0e94.

## Execution log

Task 1: dispatched (sonnet, BASE c5f0e94) — render harness + baseline snapshots.
Briefs pre-extracted for Tasks 2, 3, 4 while Task 1 runs.

Note on batching and model choice: Tasks 2, 3 and 4 are independent leaf
modules (paths, validate, protocol) whose plan text carries complete code AND
complete tests. Considered batching them into a single dispatch, but the skill
licenses batching only for the same edit repeated across files, and these are
three distinct modules each with its own tests and its own review surface. So
they go out individually on the cheapest tier, transcription-plus-testing being
exactly what they are. Task 1 got a mid tier because its Step 7 is prose and
its fixtures must be reconciled against the real type files.

Task 1: implemented DONE (commit 5387da8, 10 files). 8/8 tests across the three
canvases; 4 snapshots reported stable on a second run. Two fixture facts the
implementer surfaced, both about defects in my plan text rather than in its
work:
- The plan's `flightConfig` was missing six fields the real `Flight`/`Airport`
  types require (`Airport.name`, `Airport.timezone`, `Flight.duration`,
  `Flight.currency`, `Flight.cabinClass`, `Flight.stops`). Corrected against
  the real types and given an explicit `FlightConfig` annotation, which is what
  the dispatch instructed.
- `calendarDisplayConfig.startHour` / `.endHour` do not exist on the `Calendar`
  component's actual `CalendarConfig` prop type and are silently ignored. Left
  in place verbatim. Not pre-judged for the reviewer.

Task 1: task review dispatched (sonnet), BASE c5f0e94 HEAD 5387da8.

Task 1: review verdict — spec ❌, quality Needs fixes. One Important finding:
snapshots are timezone-dependent, not merely clock-dependent. `setSystemTime`
fixes the instant but not the timezone in which it renders, and all three
canvases format local time (`cyberpunk-header.tsx:28`, `flight/types.ts:86-93`,
`calendar/types.ts:99`, `meeting-picker-view.tsx:591-595`). The `.snap` files
match UTC only because the capture host was effectively UTC; the dev machine is
in Spain and CI runs two more platforms, so this would diverge with no code
change and defeat the task's entire purpose. A real catch that my plan missed —
the spec's determinism section named `setSystemTime` and stopped there.

Task 1: minor (deferred): `calendarDisplayConfig`/`meetingPickerConfig` carry no
explicit type annotation, so the compiler never checks them against
`CalendarConfig` — a deliberate call, because an explicit annotation trips
excess-property checks on the inert `startHour`/`endHour` fields. Revisit when
those fields are either wired up or dropped.

Task 1: minor (deferred): the three snapshot files repeat an identical
clock-pin/stdout-stub block and render-twice pattern. Brief-prescribed, so not
a defect; a shared `renderTwice(node, opts)` helper would drop ~40 lines if a
fourth canvas test is ever added.

Task 1: fix round 1/5 dispatched — resumed the original implementer with the
timezone finding. FIX_BASE 5387da8. Asked for a negative control (force
`TZ=Asia/Tokyo` for one run and confirm the snapshots still pass) rather than
accepting an assertion that the pin works, since the original run-twice check
provably cannot detect environment-varying failures.

Task 1: fix round 1/5 implemented (commit 6f72003, `canvas/test/setup.ts` only,
no production code touched). Negative control delivered as asked, and the
implementer went further: it also confirmed that removing the pin breaks 3/8
tests under the forced timezone, which proves the pin is load-bearing and not
merely harmless. Regenerated `.snap` files were byte-identical, the original
capture host having already been effectively UTC — so the negative control is
the only real evidence the pin does anything, which is exactly why it was
required. Scoped re-review dispatched (sonnet), FIX_BASE 5387da8 HEAD 6f72003.

Propagated the finding upstream, since the spec is the authority later tasks
read and it named `setSystemTime` as the whole mechanism: added the timezone
half to the spec's determinism risk and added `TZ=UTC` to the plan's Global
Constraints. Also recorded the general lesson there — a determinism check that
runs the same suite twice on one machine cannot detect environment dependence;
proving an environment pin works needs a negative control that fights it.

Task 1: fix round 1/5 (3 addressed, 0 open; commits 5387da8..6f72003). The
re-reviewer independently checked the negative control's arithmetic — the
reported shifts are exactly +9h (`09:30 AM` → `06:30 PM`), matching Tokyo's
offset — so the evidence is verifiable rather than merely asserted.
Task 1: complete (commits 5387da8..6f72003, review clean). Controller doc
commit 5a8256a is not part of the task.

Task 2: dispatched (haiku — plan text carries complete code and complete
tests, so this is transcription plus testing), BASE 5a8256a.

Task 2: implemented DONE (commit 26356af). `runtime/paths.ts` with the five
exports later tasks consume, plus its test file. 4 new tests, 12 total with
Task 1's 8 still green. Task review dispatched (sonnet), BASE 5a8256a HEAD
26356af — pointed specifically at the `darwin` and `linux` branches, which
cannot be executed on this machine and would otherwise fail first in CI, and
at whether the tests actually constrain those branches or would pass against a
wrong implementation.

Task 2: review verdict — spec ✅, quality Approved, but with one Important
finding labeled plan-mandated and one ⚠️ for me to resolve. Both concern the
same hole: `paths.test.ts` never forces `process.platform`, so only the host's
branch is exercised.

Resolving the ⚠️ myself, since I hold the cross-task context the reviewer
lacks: Task 18 defines the CI matrix as `ubuntu-latest` + `windows-latest`.
So `linux` is covered by CI, `win32` by CI and by the local run — and
**`darwin` is verified by nothing at all**, neither test nor runner. The
reviewer could not know that; it is a real gap, not a theoretical one.

Ruling 3: Task 2 enters a fix round to add platform-forced tests for all three
branches — why: the finding is plan-mandated, but the plan does not get to
grade its own work, and the spec names `win32`, `darwin` and `linux` as target
platforms. `paths.ts` is the foundation every later task builds on, and a wrong
`darwin` path means silently writing canvas state to the wrong location on
macOS — which is a primary platform for this tool's users and for the upstream
author. The fix is three cheap tests stubbing `process.platform`; the reviewer
named the mechanism. Cost if wrong: three tests that stub a global, which is
mildly invasive in a test file and must restore the original value.

Ruling 4: Task 18's CI matrix gains `macos-latest` — why: the spec names darwin
a target platform, so a two-of-three matrix leaves a stated platform
unverified end to end. One line in the matrix. Ruling 3 makes the branch
logic verifiable anywhere; this makes the real OS actually run it. Cost if
wrong: a third CI leg, marginally slower and costing macOS runner minutes.
Recorded here now, applied when Task 18 is dispatched.

Task 2: minor (deferred): `paths.ts:8,15` — `??` substitutes only on
null/undefined, not `""`, so an empty `LOCALAPPDATA` or `XDG_STATE_HOME` yields
a relative path instead of an absolute one. Unlikely but silent.
Task 2: minor (deferred): `canvasesDir()` and `logPath()` are never asserted
directly, only `canvasesDir` indirectly via `recordPath`. Brief-inherited.

Task 2: fix round 1/5 implemented (commit 252992e), test-only, `paths.ts`
untouched as instructed. Scoped re-review dispatched (sonnet), FIX_BASE
26356af HEAD 252992e.

Flagged to the re-reviewer: the fix report's arithmetic does not add up. It
claims "19 pass (4 original + 12 new platform tests + 3 pre-existing)", but
Task 1 created 8 tests, not 3, so those categories sum to 24, not 19. Either
fewer than 12 tests were added or the summary miscounts. Asked it to reconcile
against the raw output rather than trust either figure. Also asked it to check
the `afterEach` restore specifically — whether the original property
descriptor is captured and restored rather than a value hardcoded, and whether
the restore still runs when an assertion throws mid-test — since a leaked
`process.platform` override would silently corrupt the three snapshot suites
that run in the same process.

Task 2: fix round 1/5 (2 of 4 requirements addressed, 3 open; commits
26356af..252992e). Re-review resolved the arithmetic: the totals (19 tests, 33
expects) are correct and verified against the diff, but the prose breakdown was
wrong on both halves — "12 new" is 7, "3 pre-existing" is 8 — and the two
errors cancelled, which is why the total looked plausible. No correctness
impact; noted only.

Open findings going into round 2:
1. The win32/linux "uses env var" tests (`paths.test.ts:52-61`, `84-93`) are
   tautological: the env-var values chosen share literal substrings with the
   hardcoded fallback, so the assertions pass whether or not the env var is
   read. They cannot catch the swapped-env-var bug they exist for.
2. Env vars are restored by unconditional `delete` (`paths.test.ts:48-49`)
   rather than capture-and-restore, in a file-scoped `afterEach` that also runs
   after the four original tests — so the real ambient `LOCALAPPDATA` is
   stripped for the remainder of the process. This is precisely the pollution
   pattern requirement 2 was written to prevent, relocated from
   `process.platform` to the environment.

Ruling 5: the scope-creep tests stay — why: the implementer added direct
assertions on `canvasesDir()`/`logPath()` (`paths.test.ts:106-123`) against an
explicit instruction to defer that Minor finding. But they are two small,
correct tests closing a real coverage gap on functions five later tasks
consume. Deleting working tests to make a bookkeeping point is waste, and the
subagent is stateless so nothing is taught by the revert. Recorded as
unauthorised rather than reverted. Cost if wrong: the deferred-minor list no
longer matches the code, so the final review must not be told that gap is
still open.

Task 2: fix round 2/5 implemented (commit 6a4178c). Distinctive env-var markers
with both-direction assertions, and the file-scoped `afterEach` replaced by
per-test try-finally with capture-and-restore of both the `process.platform`
descriptor and env-var state including genuine absence. Report breakdown now
reconciles: 4 + 7 + 8 = 19. Scoped re-review dispatched (sonnet), FIX_BASE
252992e HEAD 6a4178c, with an instruction to be decisive — round 2 of 5 on a
33-line module, remaining findings are test hygiene rather than product
behaviour, so no hunting for refined versions of a complaint already addressed.
Asked specifically whether the `process.platform` descriptor restore survived
the restructuring, since round 1 had that part right and a restructuring is
where a correct thing gets broken.

Task 2: fix round 2/5 (2 addressed, 0 open; commits 252992e..6a4178c). The
descriptor restore survived the restructuring, verified in all 7 platform
tests. Breakdown reconciles structurally: 11 `test(` calls in paths.test.ts
plus 8 across the three snapshot files.
Task 2: complete (commits 26356af..6a4178c, review clean).

Task 3: dispatched (haiku — 15 lines of implementation and 22 fully specified
test cases, so transcription plus testing), BASE 6a4178c. Carried forward the
two test-quality lessons Task 2 paid for, since the brief cannot know them:
an assertion whose expected value is also producible by the code path it is
meant to exclude tests nothing, and a test file that mutates global state must
capture and restore it per test, treating genuine absence as a distinct state.

Task 3: implemented DONE (commit d88f7b7). `runtime/validate.ts` plus 22 tests
(6 acceptance, 15 rejection, 1 error format); 41 total with the 19 prior. The
breakdown reconciles. Task review dispatched (sonnet), BASE 6a4178c HEAD
d88f7b7, framed as a security review rather than a utility review and given
four named checks to answer: whether a trailing newline bypasses `$` (a real
bypass in some languages, and worth settling rather than assuming for JS),
what non-ASCII reaches through, what happens when a non-string arrives from
JSON or argv, and whether the rejection tests assert the specific error type
rather than a bare `toThrow()` that an accidental `TypeError` would satisfy.

Task 3: review verdict — spec ✅, quality Needs fixes. Of the four named
security checks, three came back clean and one found a real hole:
- Trailing newline: no bypass. JS `$` without the `m` flag anchors to the true
  end of input, unlike Python/Perl-style engines. Verified empirically.
- Unicode: rejected by construction — full-width, RTL override, combining
  mark, astral-plane emoji, zero-width space all fail.
- Rejection tests discriminate: they pass the constructor to `toThrow`, so an
  accidental `TypeError` would not satisfy them.
- **Non-string input: real hole.** `RegExp.prototype.test` coerces via
  `ToString`, so `assertIdent("id", undefined)` tests the string `"undefined"`,
  which matches the whitelist — it passes and returns `undefined` unchanged.
  Same for `null` → `"null"`, `123` → `"123"`, `true` → `"true"`. All four
  verified. A missing or null JSON field therefore sails through the security
  gate, and the function returns a non-string typed as `string`, which poisons
  everything downstream — `recordPath(undefined)` would build
  `.../undefined.json`. Tasks 5, 10 and 12 all trust this function.

Ruling 6: the two Minor findings are folded into this fix round instead of
being deferred — why: my own convention is that minors never enter the fix
loop, and I am overriding it here. Both minors are missing regression tests
for the trailing-newline and Unicode boundaries. Those boundaries are
currently correct, but the reviewer had to establish that empirically because
no test covers them, which means a future edit to the regex reopens the
injection hole silently. On the security boundary the whole project depends
on, a test that pins verified-correct behaviour is not polish. They are also
two or three lines each, in a file already being reopened for the Important
fix. Cost if wrong: a slightly larger fix diff and a precedent I should not
generalise — this override is specific to the injection boundary.

Task 3: fix round 1/5 implemented (commit 16f783d). `typeof` guard plus 8 new
tests: four non-string inputs, trailing newline, and three Unicode shapes.
49 total (30 validate + 19 prior), and 22 + 8 = 30 reconciles. Scoped
re-review dispatched (sonnet), FIX_BASE d88f7b7 HEAD 16f783d.

The check that matters most in this round is not whether the guard exists but
whether the new tests genuinely exercise non-strings. The parameter is typed
`string`, so the tests must cast to pass `undefined`/`null`/`123`/`true` — and
the likeliest way this fix looks done while being hollow is a cast applied to
the wrong thing, or passing the *string* `"undefined"` instead of the value
`undefined`, which would assert the opposite of the intent and still pass.
Asked for that specifically.

Task 3: fix round 1/5 (3 addressed, 0 open; commits d88f7b7..16f783d). Casts
confirmed applied to the individual argument rather than the whole call or a
pre-stringified literal, so the tests do traverse the real coercion path. One
documentation-only nit: the report's sub-breakdown says 18 rejection entries
where the diff has 19; totals are right.
Task 3: complete (commits d88f7b7..16f783d, review clean).

Task 4: dispatched (haiku — complete code and 8 complete test cases in the
plan text), BASE 16f783d.

Anticipated finding I am deliberately NOT pre-judging for the reviewer: the
`FrameDecoder` in the plan concatenates its whole buffer on every chunk and
slices it after every frame, which is O(n²) in the number of chunks. At the
16 MB ceiling that is roughly a couple of gigabytes of copying for a single
frame arriving in 64 KB pieces — slow but not fatal, and Phase 3 screenshots
are the case that would meet it. The plan mandates this implementation, so if
the review raises it I will rule on it then; recording the anticipation here so
that ruling is honest rather than retrofitted.

Task 4: implemented DONE (commit 86b990d). 8 protocol tests, 57 total with the
49 prior; reconciles. Task review dispatched (sonnet), BASE 16f783d HEAD
86b990d, with five named buffer checks — `DataView` byteOffset handling,
`subarray`-versus-`slice` aliasing, ceiling-before-allocation ordering,
endianness determined from the code rather than from tests that only talk to
themselves, and an open question about resource behaviour at the 16 MB ceiling.

That last one is phrased as an open question precisely because of the O(n²)
concatenation I anticipated above. Asking a reviewer of buffer code to
evaluate behaviour at the ceiling is a fair question; telling it what to
conclude, or telling it not to flag something, would be pre-judging. If it
finds it independently, that is worth more than my own note.

Also asked it to judge whether the 8 tests are the *right* 8, naming four
chunk-boundary failure modes a passing suite can miss: a length prefix split
across two chunks, a chunk holding one whole frame plus a partial next one, a
zero-length frame, and back-to-back pushes with no complete frame.

Task 4: review verdict — spec ✅, quality Approved. All five buffer checks
came back clean: `DataView` passes byteOffset and byteLength explicitly;
`subarray` is used only transiently and its body is consumed synchronously into
plain JS values before `slice` copies the remainder, so no aliasing bug; the
ceiling check genuinely precedes any length-proportional allocation, and the
one earlier allocation is sized by received bytes rather than the declared
length, so a hostile prefix cannot inflate it; endianness is explicitly
big-endian on both sides, read from the `false` arguments rather than inferred
from tests that only talk to each other.

The reviewer found the O(n²) concatenation independently, which is worth more
than my anticipation of it above.

Ruling 7: the O(n²) buffer growth is deferred to Phase 3, not fixed here —
why: it is a resource characteristic, not a correctness defect, and the
reviewer's Approved verdict reflects that. Phase 1's real payloads are
kilobytes of calendar config and document text; the 16 MB ceiling exists for
Phase 3 screenshots. Task 7's integration test already pushes 4 MB, which
costs roughly 128 MB of copying — tens of milliseconds, and a natural canary if
the cost is worse than estimated. Rewriting the most safety-critical parsing
code in the project to buy performance nothing currently needs is the wrong
trade, and the same reasoning rejects the reviewer's related minor (`slice` →
`subarray` at protocol.ts:38, a constant-factor saving in code where a change
risks a boundary bug). Recorded in the roadmap under Phase 3 so the phase that
needs it reads it. Cost if wrong: Phase 3 hits a slow path and has to change
the framer with screenshots already depending on it.

Ruling 8: three missing test cases DO get a fix round — why: the reviewer found
that a chunk containing one complete frame followed by a partial next frame is
untested, and that is the single most common real TCP delivery pattern, so the
framer is untested in its primary use case under realistic conditions. That is
not polish. A framing bug there manifests as intermittent corruption across the
three tasks that consume this module, which is among the most expensive
possible failure shapes to debug. Also pulling in the zero-length frame and the
exact-`MAX_FRAME_BYTES`-accepted boundary, both cheap and both currently
unpinned — only the over-ceiling `+1` case is tested, so nothing catches an
off-by-one that rejects a legal maximum frame. This is a narrower override than
Ruling 6 and rests on a different argument: not security, but that a
load-bearing parser's main path is untested. The bare `toThrow()` on malformed
JSON stays as it is — that is a native `SyntaxError`, not an app-defined error.
Cost if wrong: one extra fix round on an already-approved task.

Task 4: fix round 1/5 implemented (commit bc4dfac), 3 tests added, 60 total
(49 + 8 + 3). `protocol.ts` untouched.

PROCESS INCIDENT — my own mistake, recorded so it does not repeat. I wrote the
Ruling 7 debt note into `docs/roadmap.md` while the Task 4 implementer was
still active in this same worktree, and left it uncommitted. Something in that
agent's run restored the working tree and the edit was silently discarded:
verified afterwards that `bc4dfac` touched only `protocol.test.ts`, that
`roadmap.md` was last modified by the user's `2d45bcc`, and that no stash
existed. The earlier spec and plan edits survived only because I committed them
immediately as 5a8256a.

Corrected behaviour from here: commit controller-side documentation edits in
the same step as making them, and never leave them sitting in the working tree
while an implementer is running. The debt note was re-applied and committed as
0d1e6fb.

Task 4: fix round 1/5 (3 addressed, 0 open; commits 86b990d..bc4dfac). The
assertions discriminate — both pushes pinned with exact single-element arrays
rather than truthiness or length checks — and the max-size test allocates only
a 4-byte header while verifying against the implementation that the comparison
is a strict `>`, so a legal maximum-size frame falls through to the wait branch.
Task 4: complete (commits 86b990d..bc4dfac, review clean). Controller doc
commit 0d1e6fb is not part of the task.

Task 5: dispatched (haiku — complete implementation, complete `token.ts`, and
9 complete test cases in the plan text), BASE 0d1e6fb. Carried the three
accumulated test-quality lessons, sharpened for this task: when asserting a
dead-pid record was cleaned up, assert the *file is gone* rather than that the
read returned null, since those are different claims and only one is what the
code promises. Also warned that its tests write real files under the user data
directory, so the brief's cleanup discipline must be kept exactly or later
`listRecords` tests fail confusingly on leftover litter.

Task 5: implemented DONE (commit 7bc108b). `token.ts`, `registry.ts`,
`registry.test.ts`, 9 new tests.

Its report claimed "9 new + 52 pre-existing = 61", which reconciles only
against the `canvas/src/runtime` subset and silently drops the 8 canvas
snapshot tests — the exact narrowed-denominator pattern I had warned it about.
Settled it myself by measurement rather than by asking the reviewer to reason
about it, since it is read-only verification and not a fix: full suite is
**69 pass, 0 fail, 4 snapshots, 7 files** (60 + 9, correct), and **zero stray
record files** under the user data directory. So the code is fine and only the
report's scope was wrong. Handed the reviewer those measured numbers as facts
so it spends no effort recounting, flagged as reporting accuracy rather than a
defect.

Task 5: task review dispatched (sonnet), BASE 0d1e6fb HEAD 7bc108b, with five
named checks. The load-bearing one is the ordering of the `lastError` branch
against the liveness check: reversed, a canvas that failed to start becomes
invisible and the CLI can never explain why — which is the entire reason the
field exists, given that a canvas must exit 0 even on failure. Also asked
whether a permission error from `process.kill(pid, 0)` would misreport a live
process owned by another user as dead, and whether the four registry failure
modes a passing suite can miss are covered.

Task 5: review verdict — spec ✅, quality Approved, with two Important findings
both labeled plan-mandated. All five named checks held up on inspection:
`lastError` does precede `isAlive`, the dead-pid test asserts the file is
actually unlinked rather than just a null read, cleanup survives a failing
assertion because ids are tracked before the write, and the corrupt-record path
deletes and reports absent.

Ruling 9: both Important findings enter a fix round — why: they are gaps in my
brief's own prescribed test suite rather than implementer defects, but the plan
does not grade its own work, and both are the same failure this project has now
shipped three times — an assertion that does not discriminate.

  Finding A is the serious one. The one `lastError` test uses `pid:
  process.pid`, a live process, so it cannot tell "lastError was checked before
  liveness" from "the record survived because the process happens to be alive".
  A regression swapping those two branches passes all 9 tests. That invariant is
  the whole reason the field exists — a canvas must exit 0 even when it fails,
  so `lastError` is the only channel by which the CLI can explain a failed
  start. An untested critical invariant in a module Tasks 7 and 11 both build on
  is worth one round.

  Finding B is one word: `.rejects.toThrow()` becomes
  `.rejects.toThrow(InvalidIdentifierError)`. As written it would pass if an
  unrelated bug threw a different error for the same input, masking a real
  regression in the `assertIdent` wiring.

  Cost if wrong: one fix round on an already-approved task.

Task 5: minor (deferred): `isAlive` conflates EPERM with ESRCH, so a live
process owned by another user reads as dead and its record is deleted. Low
impact here since canvases are always spawned by the same user as the CLI, but
worth a comment in the code.
Task 5: minor (deferred): four untested-but-inspected paths — a directly
written empty or corrupt file, two `writeRecord` calls for one id, and
`deleteRecord` on an id never written.
Task 5: minor (deferred): `listRecords` against a not-yet-created directory is
untested, because earlier tests in the file already create it via
`writeRecord`'s `mkdir`. This is the literal first-run path for `canvas list`,
so Task 12 should cover it end to end rather than leaving it to inspection.
Task 5: minor (deferred): the test titled "a lastError record survives even
with no port" is misleading — the `rec()` helper always supplies `port: 1234`,
so no test constructs a record actually missing a port.
Task 5: minor (deferred): `readRecord` casts `file.json()` to `CanvasRecord`
with no runtime shape check, so a valid-JSON-but-wrong-shape file type-lies;
in practice `isAlive` throws on a bad pid and the record self-heals.

Task 5: fix round 1/5 implemented (commit 16a7e23). But its report claimed
"65/69 total suite (4 snapshot fails unrelated to registry)" and dismissed them
as "platform-specific (Windows ANSI rendering)". That claim could not be true —
I had measured 69 pass / 0 fail on this same machine minutes earlier, so any
failure had to be new rather than platform-inherent. Refused to accept it and
measured instead.

Result: from the repo root the suite is **69 pass, 0 fail, 93 expect()** — the
claim is false in the committed state. But the observation was real and the
diagnosis was wrong. Reproduced the actual cause: running `bun test` from the
`canvas/` subdirectory fails exactly those 4 snapshots, because `bunfig.toml`
lives at the repo root and its preload — the only thing pinning `FORCE_COLOR`
and `TZ` — is not loaded from anywhere else.

Ruling 10: the harness gets a fail-fast guard, dispatched separately to the
Task 1 implementer which owns that code — why: the real risk is not CI, which
Task 18 will run from the root anyway. It is that a developer running tests
from `canvas/` sees four opaque snapshot diffs, concludes the baselines are
stale, and regenerates them under unpinned colour and timezone. That silently
destroys the safety net protecting the 97 type-error edits in Task 16, and it
would look like a routine snapshot update in review. A guard that throws
"pins missing — run from the repo root" converts a silent trap into an
actionable message. Cost if wrong: a few lines in the harness and one extra
dispatch. Recording it as a ruling rather than folding it into Task 5, since it
is a different file and a different task's code.

Task 5: fix round 1/5 (2 addressed, 0 open; commits 7bc108b..16a7e23). The
re-reviewer traced the branch order explicitly and confirmed the new test would
fail under a swap: a dead pid makes `isAlive` false, so the record is deleted
and `readRecord` returns null, failing both the non-null assertion and the
file-exists assertion. It discriminates.
Task 5: complete (commits 7bc108b..16a7e23, review clean).

Ruling 10 dispatched to the Task 1 implementer, which owns the harness, BASE
16a7e23. Sequenced before Task 6 because it protects the snapshot baselines
every later task depends on, and because implementers must not run in parallel.

Ruling 10: implemented and reviewed clean (commit 32299c5, harness plus one
guard test; 70 pass from the repo root). The guard is the first statement of
`renderCanvas`, before Ink is touched; its message interpolates both variable
names and actual values; its test matches `/repository root/`, a phrase unique
to this guard, so it cannot pass on an unrelated harness break; and `colorOk`
accepts any `FORCE_COLOR` other than absent or `"0"`, so `2` and `3` still
work — no valid configuration is newly rejected.

Worth recording: from `canvas/` the failure count went from 4 to 8. The guard
fires on every `renderCanvas` call, so all 8 render tests now fail loudly,
where before only the 4 snapshot-comparing ones failed and the other 4 passed
silently under the wrong environment. The prior state was worse than it looked.

Task 6: dispatched (sonnet rather than the cheapest tier — first task with real
async socket handling and per-connection state, where a transcription slip is
subtle and test flakiness is a genuine risk), BASE 32299c5.

Sharpened the accumulated lessons for this task: the tests proving an
unauthenticated client is rejected must assert `onMessage` was **never called**,
not merely that an error frame came back. An implementation that sent an error
and also delivered the message would satisfy the weaker assertion while leaving
the port wide open — the same non-discriminating-assertion failure, in the one
place where it would be a security hole rather than a coverage gap.

Task 6: implemented DONE_WITH_CONCERNS (commit 16edaa6), 77 pass (70 + 7). The
concern is a deliberate deviation from my brief's mandated code, and it is
correct: `send(error); socket.end()` synchronously **loses the frame** on
Windows/Bun, because closing while the peer has unread inbound data queued
produces an OS-level RST that discards the buffered write. Isolated outside
project code and measured at 33 failures in 40 runs with an immediate close
against 0 in 60 deferred. Fixed by deferring the close one tick with a
per-connection `rejected` guard — not by extending a test wait, which is what
I had asked for.

Ruling 11: the deviation is accepted — why: the measurement is convincing, the
failure is a real platform behaviour rather than test flakiness at a 33/40
rate, and the brief's code cannot deliver the `error` frame it promises. The
alternative, keeping mandated-but-broken code, would ship a server whose
authentication failures look like unexplained disconnects. Cost if wrong: the
deferral opens a window in which frames arrive on an already-rejected
connection, so the `rejected` guard is now load-bearing; sent to review as the
first thing to verify, because if a frame can reach `onMessage` in that window
we have traded a lost error message for an authentication bypass.

Cross-task consequence, carried forward to Task 7: **`requestClose` has the
identical send-then-close shape** — `conn.send({type:"close"}); conn.close()`.
If the brief was wrong here it is wrong there too, and the symptom is worse: a
dropped close frame means the canvas is never asked to exit, and since a canvas
must exit 0 by itself because nothing can remove a pane otherwise, that is
precisely how a zombie pane appears. Recorded in the spec as b1f1f80 so it
binds Task 7 rather than living only in this ledger.

Task 6: review verdict — spec ✅, quality Approved. The deviation was verified
safe on all four points: `state.rejected` is set synchronously before the close
is scheduled and checked at the top of `data`, so the window is closed by JS
single-threadedness rather than by timing luck; the close is scheduled
unconditionally and at most once; `setTimeout(0)` is a macrotask, which is the
correct primitive because a microtask drains before the loop returns to the I/O
poll phase and so would not let queued inbound data surface first; and the
success path still uses plain `send()`.

Resolved the reviewer's ⚠️ by measurement: from the repo root the server suite
is 7 pass and the full suite is **77 pass, 0 fail across 9 files**.

Ruling 12: one fix round with three items — why each:

  (a) Tests do not stop servers on an assertion-failure path (no `try`/
  `finally`). Important and plan-mandated. Practical impact is blunted because
  the server binds an ephemeral port, so a leaked listener will not collide
  with a later test, but it is still a resource leak on failure and the fix is
  one wrapper per test.

  (b) No test exercises two concurrent connections with differing auth
  outcomes. The reviewer filed this Minor; I am promoting it. Per-connection
  auth state exists specifically to prevent one authenticated client from
  blessing every other connection, and **nothing currently tests that
  property** — it is correct by inspection only. Same reasoning as Ruling 6: on
  a security boundary, a test that pins verified-correct behaviour is not
  polish, because the next edit is what silently reopens the hole.

  (c) The unguarded `socket.end()` in the deferred timer. The reviewer filed
  this Minor and, task-scoped, that is fair. I am promoting it on cross-cutting
  grounds it did not have in front of it: an uncaught exception in a bare timer
  callback terminates the process with a non-zero exit code, and the spec's
  hard invariant is that a canvas **always** exits 0, because on Windows a
  non-zero exit leaves a pane that no command can remove. So this is not a
  tidiness issue — it is a direct route to the zombie pane the whole lifecycle
  design exists to prevent. Route the error through `onError` instead.

  Cost if wrong: one fix round on an approved task, and three small changes in
  files that are otherwise settled.

Task 6: minor (deferred): no tests for a second `hello` on an
already-authenticated connection, a frame arriving after `stop()`, or a client
disconnecting mid-handshake. All three are safe by inspection; none is on the
authentication boundary the way (b) is.

Task 6: fix round 1/5 (3 addressed, 0 open; commits 16edaa6..4b74dd0). The
re-reviewer established that the per-connection test discriminates via one
specific assertion: the earlier checks are order-sensitive and would not
reliably fail under a shared flag, but the broadcast-exclusion assertion is
deterministic, because `broadcast` runs after both handshakes settle, so a
shared flag would deliver to the unauthenticated connection. Measured: 8 tests
in server.test.ts, 78 pass across 9 files. Report claimed "15/15" for that
file; wrong, totals right — third report with a garbled breakdown.
Task 6: complete (commits 16edaa6..4b74dd0, review clean).

Carry to Task 11: the server now routes a throwing `onMessage` into `onError`
rather than letting it terminate the process. That means a consumer which does
not wire `onError` turns a handler bug into total silence. Task 11 is the
consumer and must wire it.

USER DIRECTION: all subagents on sonnet from here (no haiku, no opus), and
dispatch prompts kept short — the brief carries requirements, the dispatch adds
only what the brief cannot know. The controller's own context is the real cost,
since every prompt written and report received is re-read each turn.

Task 7: dispatched (sonnet), BASE 4b74dd0, carrying the send-then-close
correction as a mandatory deviation rather than leaving it to be rediscovered.
