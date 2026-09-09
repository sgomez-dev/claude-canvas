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
| 4. Phase 3/dashboard/build | ✅ done | ✅ done (found 1 coverage gap) | ✅ 1 test patch | **FULLY COMPLETE** |

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

## Area 4 (Phase 3 start + build/bundle/CI) — COMPLETE

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

## Area 4 scoped re-review — DONE

Carried out directly rather than by dispatching an agent. All three
candidates the previous update flagged were checked, and the fix wave's
headline claims were verified by sabotage rather than by reading:

**Verified sound:**

- **Focus routing is genuinely covered now.** Two sabotages on the real
  `Dashboard`: forcing `focused = true` for every region fails 4 tests, and
  disabling the Home/End handler fails 2. The blindness the original review
  proved by hardcoding `isActive: true` is closed.
- **The Home/End key choice collides with nothing.** No other view binds
  `key.home` or `key.end` anywhere in the tree — checked exhaustively, not
  spot-checked.
- **The focus gate reached every composable view.** All five of picker,
  table, form, diff and tree gate on `focused`, plus the inline `text`
  region. This was the highest-risk candidate, being the exact
  "structurally right, incompletely applied" shape `canvas/CLAUDE.md` warns
  about.
- **`check:standalone` can actually fail.** Rebuilt the bundle with
  `--external react-devtools-core` (the original defect) and the check
  exits 1; restored, it exits 0. No platform-specific gap of the kind Area
  1's Windows-only rename retry had — the mechanism is Bun's module
  resolution, not a filesystem behaviour.

**Finding: no dashboard test used a `form` or `diff` region.** Every test
written for this fix wave used `text`, `picker`, `tree` or `table` — so the
two region kinds whose own key handling *motivated* moving region-switching
off Tab had no dashboard coverage at all. `form` binds Tab to its own field
navigation and `diff` has the densest key set of any region (a/r, PgUp/PgDn,
Enter). The behaviour turned out to be correct; nothing proved it.

That is the same shape as the gap the original review found in the
neighbouring file, and the third time in this effort that the surface
*adjacent* to the scrutinised fix was the one carrying the gap.

Closed with `test/integration/dashboard-form-diff-regions.test.tsx`, 5
tests, both directions verified by sabotage: putting region-switching back
on Tab fails the two form tests, and making the diff view ignore focus fails
the isolation test.

**Ruling: my own first probe failed for the wrong reason, and I nearly
reported a defect that was not there.** The probe asserted that End moves
focus off a focused form; it failed, and the obvious reading was that a form
region blocks region-switching. It did not. `isActive` on a newly-focused
view only takes effect once Ink re-registers its `useInput` handler, one
render later, so a keystroke sent after a single `settle()` is still routed
by the previous assignment — the same registration-lag race that has caught
this project at least three times, including in a test I wrote myself and
in a CI-only failure earlier today. Checking what the *passing* neighbour
test did differently, instead of trusting the first failure, is the only
reason this went into the ledger as a coverage gap rather than as a
phantom bug. Cost if wrong: a fix applied to code that was already correct.

## Next steps for the resuming session

**All four areas are now closed.** This cross-cutting review effort is
complete: 410 tests, `tsc --noEmit` clean, CI green on all three platforms.

What remains is the process question this review raised for the user's
judgment, not something a session should decide for itself:

1. **Whether Phase 3 (composition, dashboard, tree) and the plugin
   packaging work should be formally considered "scoped and accepted".**
   Phase 3 was thinly pre-authorized by the roadmap, and the same
   unreviewed session that built it also wrote its own authorization for
   it. The plugin bundling was not in any phase's scope at all — it came
   out of the user asking how to try the thing.
2. **Then Phase 3 sub-project 3**, the image pipeline. Its starting point
   is written up in `2026-09-08-richer-canvases-progress.md`, including
   which tier to build first and why not to start with Sixel.

Historical note on what the original plan said to do here:

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
