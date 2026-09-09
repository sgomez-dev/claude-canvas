# SDD ledger — independent review of the unreviewed main merge (UPDATE)

**This document replaces and supersedes `docs/superpowers/2026-09-09-main-merge-review-progress.md`'s
prior version (which covered Area 1 only). It now covers the full
4-area review effort through Area 4's fix wave.**

## Context (unchanged from the original)

On 2026-09-08, a different Claude Code session picked up this
project's Phase 2 spec and plans and, over 30 commits, completed all
four Phase 2 primitives, fixed several Phase 1 defects, and started
Phase 3 (dashboard/tree) plus plugin packaging — with **no second-pass
independent review**, by that session's own admission. This session
was asked to be that missing review round: four independent Opus-tier
reviewers (runtime/transport, the four primitives, scenario registry
+ CLI + calendar, Phase 3 + build/CI), each empirically verifying
every claim rather than trusting it.

## STATUS AS OF THIS UPDATE

| Area | Fix wave | Scoped re-review | Patch round(s) | Status |
|---|---|---|---|---|
| 1. Runtime/transport | ✅ done | ✅ done (found 3 residuals) | ✅ 1 surgical patch | **FULLY COMPLETE** |
| 2. Four primitives | ✅ done | ✅ done (found 1 Critical + gaps) | ✅ 1 surgical patch | **FULLY COMPLETE** |
| 3. Registry/CLI/calendar | ✅ done | ✅ done (found 2 Critical + gaps) | ✅ 2 surgical patches | **FULLY COMPLETE** |
| 4. Phase 3/dashboard/build | ✅ done | ❌ **NOT YET DISPATCHED** | — | **RESUME HERE** |

**Workflow note:** mid-session the user switched this effort from
feature branches to trunk-based development — every fix wave, patch,
and doc commit from Area 2 onward committed and pushed directly to
`main`. No open branches remain from this effort; `main` IS the
current state.

**Process note:** every commit in this effort was independently
verified by the controlling session before being trusted (CI status
via `gh run list`/`gh run view`, commit authorship and absence of
attribution trailers via `git log`/`grep`, and for the highest-stakes
fixes, the actual diff read directly) — never accepted on the
implementer agent's own report alone. This project's `canvas/CLAUDE.md`
now has a "Verifying a fix" section codifying the discipline that made
this review effective: reproduce the bug broken, fix it, reproduce it
fixed, try a harder variant, and never accept "looks right" or
"probably just flaky" without checking. **Every area reviewed so far
has needed at least one patch round after its first fix wave** — Area
4 should be assumed to need one too until proven otherwise.

---

## Area 1 (runtime/transport core) — COMPLETE

Two Criticals found and fixed: outcome persistence silently EPERM'd on
Windows (the platform this project is developed on) due to a rename
racing this project's own polling reader, discovered from the
committed test suite's own log output (8/8 clean runs); and a
deterministic `spawn` id handing a NEW invocation a STALE outcome from
a previous one. Nine further Important fixes (TTL measured from the
wrong timestamp, a live canvas's record deleted on outcome-read,
unbounded queued-writer memory, colliding temp file paths, fixed-sleep
test flakiness, a permissions-window claim that didn't hold, tests
mutating the real global registry directory). The scoped re-review
found 3 of these 9 fixes had real residual gaps (a retry budget tuned
to one specific race shape, a cleanup that never actually ran before
process exit, a "0 flakes" claim that was false under load) — closed
in one surgical patch. Final: 7 commits, 306 tests, CI green.

## Area 2 (the four primitives) — COMPLETE

Headline: the stale-closure `useInput` bug this project has hit
repeatedly was found STILL LIVE in all four primitives despite code
comments claiming it was fixed — silently misattributing a diff
approval, dropping a picker toggle, swallowing a form submit. The fix
wave patched the KNOWN sites (diff's cursor/decisions refs, picker's
cursor/checked refs, form's focusIndex ref) plus 5 other Important
fixes (crash-on-malformed-config, a viewport off-by-one, an unclamped
scroll offset, a form field silently violating its own declared min,
an unwindowed textarea, a table width-table gap for common status
emoji). The scoped re-review found the fix wave's OWN focusIndexRef
fix was thorough, but `valuesRef` (a DIFFERENT ref in the same
component) was never patched at all — an unfixed instance of the exact
bug this wave targeted, worse than the original (silently reports a
*successful* submission with wrong/default data). Closed by
eliminating the mirror-ref pattern entirely for `values` (single
source of truth in a plain ref, mutated directly, with a bare
re-render trigger) rather than hand-patching more call sites — plus 4
more Important fixes (footer-wrap measuring the wrong string, a
word-wrap estimate that under-counted real wrapping, textarea
windowing counting newlines instead of rendered rows, an ironic
same-bug-class ref in diff's OWN Fix 3 that had just been added).
Final: 12 commits total across fix wave + patch, 346 tests, CI green.

## Area 3 (scenario registry + CLI + calendar) — COMPLETE

Headline: the calendar meeting-picker's own overflow-fixing paging
logic introduced a NEW mis-booking bug — hovering the mouse near the
bottom of a capped last page could silently re-page the grid with no
visible change, and a click then booked a slot hours away from what
was on screen. Fixed by making the window "sticky" (only repages when
the cursor is genuinely outside the current window, never re-derived
from scratch). Plus: calendar `display`'s own identical unfixed
overflow bug (with a snapshot baking in the broken output as
baseline); `display` never sending a cancel outcome on quit; missing
config validation (empty calendars array, bad slotGranularity); two
dead config fields (`startHour`/`endHour` wired up for real,
`minDuration`/`maxDuration` removed since making them real needs
out-of-scope UX); several stale/self-contradicting doc claims. The
scoped re-review found this fix wave's OWN Fix 6 (a real timezone-
conversion feature added along the way) broke the shipped `flight`
skill doc's own worked example into a hard crash, plus two MORE
"hardcoded constant, doesn't account for variable content" bugs in the
neighboring surfaces the mouse-mapping fix had just touched (the
meeting-picker's legend can wrap to 2 lines, shifting the grid by a
row the mouse-mapping code didn't know about; `display`'s all-day
events row height is similarly hardcoded at 0). Closed in two more
surgical patches (5 commits total for the second one, after the first
patch's own residual was self-disclosed and adjudicated to park rather
than chase a 4th round). Final: 19 commits total, 381 tests, CI green.

## Area 4 (Phase 3 start + build/bundle/CI) — FIX WAVE DONE, RE-REVIEW PENDING

**This is the resume point.** The original review found: the
dashboard's 11 own tests are provably blind to its own focus routing
(proven by breaking it live — all 11 stayed green); zero focus
indicator exists anywhere; Tab collides between dashboard region-
switching and a composed Form's own field navigation; a `text` region
ignores its row allocation entirely; `check:standalone`'s verification
cannot fail on the bug it exists to catch (Bun's auto-install defeats
it); the same check doesn't actually exercise the render path its own
comment claims; the `canvas`/`canvas` command name collides with
itself and the surviving copy is stale; the README overclaims smoke-
test coverage.

The fix wave (8 commits, `9884bff`..`58049cf`, already on `main`,
independently verified: CI green, correct authorship, no attribution
trailers) addressed all of these. Notably, while fixing the
render-path check (Fix 6), the implementer's own first attempt had a
genuine cross-platform bug (an assertion that passed locally but
failed identically on all 3 CI platforms, because Ink's raw-mode error
screen preempts the initial frame flush) — they diagnosed the actual
mechanism via the CI failure rather than just re-running, and shipped
a correct follow-up commit. This is the exact discipline this whole
review effort has been built on, self-applied without prompting.

**What's NOT done yet:** Area 4's fix wave has NOT been through a
scoped independent re-review, unlike Areas 1-3. Given every other area
found real residual gaps on re-review — usually in the surfaces
NEIGHBORING the most-scrutinized fix, not the headline fix itself —
Area 4 should get the same treatment before being trusted. Candidates
worth particular scrutiny going in (not confirmed problems, just where
this pattern has repeatedly struck): the Tab-collision fix's exact key
choice (Home/End) interacting with any OTHER composed view that might
already use Home/End; whether the new focus-indicator fix (gating
cursor/highlight on `focused`) was applied to every composable view
kind or just some; whether the `check:standalone`'s `--no-install` fix
has any platform-specific gap the way Area 1's Windows-only rename
retry did.

## Next steps for the resuming session

1. `git fetch origin && git log --oneline -10 origin/main` to confirm
   current state matches `58049cf` as this document's tip (or later,
   if anything landed since).
2. Dispatch a scoped Opus re-review of Area 4's fix wave, same process
   as Areas 1-3: checkout `main` directly (trunk-based, no branch),
   independently reproduce each of the 9 fix claims with harsher
   probing than the original implementer used, hunt for anything the
   fix wave's own new code introduced.
3. Adjudicate findings the same way every other area did: if the
   findings are precisely diagnosed with a clear mechanism, one
   surgical patch (not a second full fix-wave-plus-re-review cycle);
   if something is genuinely out of scope or lower-severity than
   everything else found, it's fine to park it with an explicit
   ruling and a documented reason, the way Area 3's leftover
   `display`-scenario startHour/endHour validation gap was parked.
4. **After Area 4 is fully closed**, this cross-cutting review effort
   is complete. At that point, revisit with the user whether Phase 3
   (dashboard/tree) and the plugin-packaging work should be formally
   considered "scoped and accepted" — this was flagged as a process
   question for the user's judgment early in this review (Phase 3 was
   thinly pre-authorized by the roadmap; the same unreviewed session
   that built it also wrote its own authorization for it), not
   something resolved by any of the code fixes above.
5. Independently verify everything the same way this session did at
   every step — don't accept an implementer's or reviewer's own
   characterization without checking `gh run list`, commit messages,
   and (for anything load-bearing) the actual diff.
