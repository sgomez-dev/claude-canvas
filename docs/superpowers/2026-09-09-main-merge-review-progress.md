# SDD ledger — independent review of the unreviewed main merge (UPDATE)

**This document replaces and supersedes `docs/superpowers/2026-09-09-main-merge-review-progress.md`'s
prior version (which covered Area 1 only). It now covers the full
5-area review effort, post-review debt closure, and Phase 4's
publishing tooling.**

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
| 5. Image canvas / graphics | ✅ done | ✅ done (found 1 Critical + gaps) | ✅ 2 surgical patches | **FULLY COMPLETE** |

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
implementer agent's own report alone. This project's root `CLAUDE.md`
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
  "structurally right, incompletely applied" shape the root `CLAUDE.md` warns
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

## Addendum (2026-09-10): a fifth area — the image canvas — was reviewed and closed the same way

After this document's original "Area 4 complete, all four areas
closed" milestone, a session (not the one that wrote the rest of this
document) picked up the resume-here pointer, correctly closed Area 4's
scoped re-review (found one real gap: no dashboard test exercised a
`form` or `diff` region, closed with 5 sabotage-verified tests), and
then went further: closed a marketplace-blocking plugin manifest, and
built an entire new subsystem — a dependency-free PNG decoder, a
half-block terminal renderer, and kitty/iTerm2/Sixel/tmux-passthrough
graphics encoders, wired into a new `image` canvas kind end to end
(Phase 3 sub-project 3, per this project's roadmap). That authoring
pass was itself unusually rigorous — commit messages show genuine
"sabotage-checked" tests (deliberately reverting a fix to confirm the
test catches it) and verification against independent oracles (it
found a real bug in its own Sixel encoder by diffing output against
`libsixel`'s decoder).

But it had never had an independent second-pass review either — the
exact root-cause pattern this whole document exists to record, however
careful the authoring pass looked. The user (this project's maintainer,
who develops on Windows) specifically flagged a concern before the
review even started: "me preocupa que se pueda usar en Mac también" —
inverted from the usual worry, since this new work had clearly been
tested hands-on on Apple Terminal (macOS) and never mentioned Windows
Terminal anywhere in its own ledger. That specific instinct was
correct: the review's one Critical finding was a Windows Terminal
detection bug reproduced directly on the maintainer's own machine.

**Area 5 (image canvas / graphics subsystem) — now COMPLETE, same
process as Areas 1-4 (review → fix wave → scoped re-review → one
adjudicated patch round):**

- **Critical, found and fixed:** `detectGraphics` classified a fully
  capable Windows Terminal running native PowerShell/cmd.exe as having
  "no terminal at all," because its `TERM`-empty bailout ran before the
  `WT_SESSION`-based Windows Terminal check — and native Windows shells
  never set `TERM` (a POSIX convention), with or without Windows
  Terminal hosting them. This made a whole already-reasoned code branch
  dead on the maintainer's actual default shell, and had Claude being
  told the terminal could paint nothing. Images still rendered, by an
  unpinned accidental fallthrough. Fixed by exempting `WT_SESSION` from
  the bailout rather than reordering the function, verified end-to-end
  through the real CLI on the maintainer's own machine, with a new test
  constructing the exact no-`TERM` environment (the existing test
  helper that would have caught this was itself injecting `TERM` and
  masking the bug).
- **Important, found and fixed (first patch round):** a PNG "zlib bomb"
  (a small file whose compressed data decompresses to gigabytes,
  because the decompression call had no output-size bound); a stale/
  superseded image config still ran a slow synchronous decode to
  completion before being discarded, blocking the IPC server and
  Escape handling; the kitty graphics protocol's "clear" command
  deleted every image on the whole terminal rather than just its own
  canvas's, so two image canvases side by side would blank each other;
  `tree`'s viewport-overflow fix didn't measure its own actual rendered
  content and the `columns` prop it needed was never passed by
  `dashboard.tsx` in production.
- **Important, found and fixed (second patch round, after the
  fix wave's own honest self-disclosure of an unaudited question):**
  the "does `tree`'s missing-`columns` bug also affect `picker`/
  `table`/`form`/`diff`?" question the first fix wave explicitly
  flagged as out-of-scope-for-them turned out to be exactly where the
  real remaining defect was — all four DO have the identical gap,
  reproduced through the real `Dashboard` component: an ordinary
  table+picker split pane at 50×24 pushed the dashboard's own
  "Home/End: region  Esc: close" hint — the only on-screen way to
  switch focus or exit — two rows off screen. A prior fix wave's own
  regression test for the image-decode-ordering fix was also found to
  be non-discriminating (reverting the actual fix left the test green).
  Both closed, verified via the real `Dashboard` at multiple widths and
  a `decodePng`-call-count instrumentation respectively.
- **Explicitly parked, not chased further:** the same "measure only the
  footer, not the content rows or prompt row" wrap-budget gap now
  exists as roughly a third generation of essentially the same bug
  shape in `picker`/`tree`'s own budget math — real, but pre-existing
  (predates this whole image-canvas effort), shared across the entire
  composable-view family, and needs a structural fix (deriving the
  budget from a real wrap-measurement over EVERY row a view renders,
  not just its footer) rather than another one-off patch. Recorded here
  for whoever picks it up next.

Final state: 550 tests, `tsc --noEmit` clean, CI green on all three
platforms, all commits directly on `main` (trunk-based — no branch was
created for this area), independently verified at every step by the
controlling session (CI status, commit authorship, absence of
attribution trailers, and for the highest-stakes fixes, the actual
diff read directly — never accepted on an implementer's or reviewer's
own report alone, consistent with every other area in this document).

**All five areas — the original four-area unreviewed-merge review plus
this follow-on image-canvas review — are now fully closed.** The
process question this document has flagged twice now (Phase 3's thin
roadmap pre-authorization, and now Phase 3 sub-project 3 built the same
way) remains open for the project owner's judgment — not resolved by
any of the code fixes in this document, and not something a future
session should decide unilaterally if further unreviewed work surfaces
the same way again. The pattern that closed all five areas is worth
repeating verbatim if it does: review independently, fix what's found,
re-review the fix, adjudicate what's left with an explicit ruling
rather than an endless chase — and take any concern the project owner
raises about their own actual environment (this session's Windows
Terminal concern) as a specific, high-priority thing to verify, not a
generic worry to note and move past.

---

## Post-review debt closure (2026-09-10)

Before starting Phase 4 (publishing), per explicit user instruction
("vamos primero con las deudas, que son lo más importante antes de
publicar"), two items of known technical debt were closed — identified
by re-reading `docs/roadmap.md` directly plus this document's own Area
5 ledger, not from memory:

1. **Reuse detection (Phase 1-era debt, deferred since the original
   design doc, never built).** `runSpawn` unconditionally opened a new
   pane and silently overwrote an existing registry record for the
   same `--id`, even with a live pid — orphaning the first pane's
   port/token permanently. Fixed by refusing cleanly (not attempting
   ambiguous "reuse") when `readRecord(id)` + `isAlive(pid)` show a
   live record already exists, pointing the caller at `canvas close`
   or a different `--id`. Commits `163a420`..`bfb69b0`.
2. **The footer/content-measurement structural bug** parked at the end
   of Area 5's re-review (its own NEW-2) — a third generation of
   "measure only the footer, not the content rows or prompt row" in
   the composable-view family. Fixed structurally: prompt lines now
   measured via `wrappedLineCount` (matching the already-correct
   footer pattern) in `picker`/`tree`; per-item content rows (option
   labels, node labels, field labels, file-list/hunk-header lines)
   truncated via a new shared `truncateWithEllipsis` helper,
   generalizing `table`'s own pre-existing `fitCell` convention. Bonus
   fix found along the way: `table`'s summed column width is now
   capped against the terminal, not just each column individually.
   Commits `bcf478f`..`8d564b9`.

A third item surfaced by the user's own follow-up question ("que falta
para que sea lo único que falta") — `calendar display`'s
`startHour`/`endHour` were parseable but never validated, unlike every
other numeric config field in the project — was closed the same way:
commits `7c008f6`/`92cdb79`/`9f9c3c5`. This surfaced a real (if minor)
CI-hardening issue: a macOS-only CI failure on the new test traced to
a pre-existing, twice-duplicated pattern (`awaitRecord`'s return value
discarded before an unconditional `openConnection` call) already
present, unfixed, in a sibling test file that had been green for a
while — fixed across all 4 files it was found in, not just the one
that failed, commits `0141c91`/`47a99f9`.

## Plugin permission recommendation (2026-09-10)

Before Phase 4, per the user's own request for a permissions
recommendation: `.claude/settings.json` added at the repo root with a
narrowly-scoped Bash allow rule for this repo's own canvas CLI
invocation pattern, plus documentation for other users installing the
plugin elsewhere (`canvas/README.md` substantive, `SKILL.md` and
`commands/canvas.md` one-line pointers). Commit `a9b2f7f`.

## Phase 4 (publishing tooling) — COMPLETE

`docs/roadmap.md`'s "reuse conventions from claude-skills" directive
was investigated against the actual referenced repo rather than
assumed: `claude-skills` is architecturally a different kind of
project (plain markdown slash-commands installed via `install.sh`)
versus claude-canvas (a real TypeScript plugin, already installable
via the standard Claude Code marketplace flow) — the user confirmed
adopting only the underlying ideas, not the literal install mechanism.
Separately confirmed (per the user's attribution concern) that
`plugin.json`/`marketplace.json` already correctly list
Santiago/sgomez-dev as author/owner, with David Siegel's original
upstream copyright correctly and separately retained in
LICENSE/README's Credits section — nothing needed changing there.

5 commits (`12f9af8`..`ec018a1`) on `main`:
- `scripts/lint-permissions.ts` + `scripts/lint-shared.ts` — cross-checks
  `.claude/settings.json`'s allow rules against every documented CLI
  invocation in `canvas/skills/*/SKILL.md` + `canvas/commands/*.md`,
  plus a pruned dangerous-shell-pattern safety scan. Differentially
  proven by reintroducing the exact shipped "missing run" permission
  bug caught earlier in this effort.
- `scripts/lint-skills.ts` — SKILL.md frontmatter/description-length
  validation plus a bidirectional cross-check against `cli.ts`'s real
  `KIND_DEFAULT_SCENARIO` list, directly targeting this project's own
  repeated stale-doc-drift history.
- `scripts/check-versions.ts` — found and fixed a real pre-existing
  drift (root + `canvas/package.json` stuck at `0.1.0` while
  `plugin.json`/`marketplace.json` were already at `0.2.0`).
- All 3 wired into `package.json` scripts and 3 new CI steps.
- `CONTRIBUTING.md` written for this repo's actual architecture (not
  copied from `claude-skills`) — restates the shell/view/validator
  split and the "Verifying a fix" discipline, quotes this project's own
  real commit-message conventions.

## TRUE FINAL STATE (2026-09-10)

Everything identified across this entire multi-day effort is closed,
on `main`, CI green, independently verified at every step: the
original 4-area unreviewed-merge review, the follow-on image-canvas
review (Area 5), 3 post-review debt items, the plugin permission
recommendation, and Phase 4's publishing tooling. The process question
this document has flagged (Phase 3's thin roadmap pre-authorization,
repeated for Phase 3 sub-project 3) remains open for the project
owner's judgment. Nothing else known-and-tracked remains before the
actual marketplace publish step, which is the project owner's own
action outside of code.
