# Contributing to claude-canvas

This is a Claude Code plugin: a real TypeScript CLI (`canvas/src/cli.ts`)
rendered with Ink/React, shipped as a committed bundle
(`canvas/dist/cli.js`) so `/plugin install` works with no `node_modules`. It
is not a folder of prompt-template `.md` files, so "add a skill" here means
"add a working canvas kind with tests," not "write a new markdown file."

## Setup

```bash
bun install
```

Everything below runs from the **repository root** — that's where
`bunfig.toml` lives, and the `[test].preload` that pins `TZ`/`FORCE_COLOR`
for deterministic snapshots is only discovered from there.

## Adding a new canvas kind

Fully documented in [`CLAUDE.md`, "Adding a New Canvas
Type"](CLAUDE.md#adding-a-new-canvas-type) — read it before starting, it's
short and everything below assumes it. The one-line version: a kind must be
registered in `KIND_DEFAULT_SCENARIO` (`canvas/src/cli.ts`), given a `case`
in `renderCanvas` (`canvas/src/canvases/index.tsx`), registered in
`canvas/src/scenarios/registry.ts`, given a skill doc
(`canvas/skills/<kind>/SKILL.md`), and covered by a render snapshot plus a
real-socket IPC test. Miss the first of those and `spawn` rejects a
correctly-spelled kind at the validation gate that exists specifically to
catch typos — that's not a bug, it's `assertKnownKind` in `cli.ts` doing its
job, so check `KIND_DEFAULT_SCENARIO` first if a new kind won't spawn.

Since Phase 3, a primitive canvas is **three** files
(`canvas/CLAUDE.md`'s "Canvas anatomy" section, reproduced from
[`CLAUDE.md`](CLAUDE.md#canvas-anatomy-view-shell-validator)):

```
canvases/<kind>.tsx           the shell: live config, IPC server, Escape, the outcome
canvases/<kind>/view.tsx      the view: rendering and local interaction, no IPC
canvases/<kind>/validate.ts   the validator: a pure function the shell and dashboard both call
```

Three rules from that section that are load-bearing, not stylistic — get
these wrong and the failure is usually silent:

1. A view must never handle `Escape` — that belongs to the shell alone, or a
   composed canvas becomes un-exitable through whichever region is focused.
2. A view must not guard its own double submit — the shell enforces
   first-outcome-wins, because the outcome is the shell's to own.
3. Reset a view by remounting it (a `generation` counter the shell bumps on
   every pushed config), not by clearing state by hand — `form`'s values and
   `diff`'s decisions are keyed by field/hunk id, and a missed reset
   misattributes an answer to the wrong thing without erroring.

`scripts/lint-skills.ts` (`bun run lint:skills`) checks the mechanical half
of "does the skill doc match the code": every kind in `KIND_DEFAULT_SCENARIO`
has a `SKILL.md`, and every `SKILL.md` names a kind that still exists. It
does not check that the doc's *claims* are still true — that's on you and
reviewers, see the next section.

## Running tests

```bash
bun test                # whole suite, from the repo root
bun x tsc --noEmit       # typecheck
```

Conventions actually in force here, not aspirational:

- **Render snapshots must be deterministic across OS/locale/timezone.**
  `canvas/test/setup.ts` pins `TZ=UTC` and `FORCE_COLOR=1` for exactly this
  reason (colour output is all-or-nothing and environment-dependent; the
  same frame measured 752 chars without colour and 1057 with it). Locale
  can't be pinned from an env var on this platform (Bun ignores
  `LANG`/`LC_ALL` when resolving `Intl`'s default locale on Windows) — the
  fix is an explicit locale at every `toLocaleTimeString`/`toLocaleDateString`
  call site, not another environment hack. If a snapshot only fails on one
  OS in CI, look for a bare locale-dependent call before assuming flakiness.
- **Real-socket IPC integration tests, not mocks.** `canvas/test/integration/`
  and `canvas/test/harness/ipc.ts` spin up the actual length-prefixed JSON
  frame protocol over a real local socket (`canvas/src/runtime/protocol.ts`,
  `client.ts`, `server.ts`) rather than stubbing it — the registry-write
  race, the `ready`-then-outcome ordering, and the "outcome persists even if
  nobody's listening yet" guarantee are exactly the things a mock would
  paper over. New IPC-observable behavior (a new outcome shape, a new
  `onUpdate`/`onGet` key) needs a test at this level, not just a view-level
  render test.
- **Ink needs a real stdin/stdout stand-in, not a plain object.**
  `canvas/test/harness/render.tsx`'s `TestStdin` is a mandatory `EventEmitter`
  subclass for any canvas using `useInput` — without it, Ink silently
  renders its own "Raw mode is not supported" error screen as a normal
  frame, nothing throws, and the test passes while snapshotting a stack
  trace instead of your component.

## Verifying a fix

This is the discipline this project has paid for the hard way — see
[`CLAUDE.md`, "Verifying a fix"](CLAUDE.md#verifying-a-fix) for the full
version and its examples. The short version, which applies to every PR that
claims to fix something:

1. **Reproduce the bug on the unfixed code first**, with a concrete
   input/action and the exact wrong output. If you can't make it fail on
   demand, you don't understand it well enough to fix it.
2. Apply the fix.
3. Reproduce the same scenario and confirm the correct output — actual
   before/after evidence, not "looks right."
4. Try at least one variant harder than the case that found the bug: a
   different ratio/size than the first case, a zero-delay sequence instead
   of a slow one, the sibling code path that shares the same bug's shape. A
   fix that only survives the exact case that found it usually isn't one —
   this project has shipped a ref-mirror pattern applied to 3 of 11 call
   sites and a windowing fix that closed one overflow path while leaving an
   identical sibling open, both of which read correctly and passed a first
   review.

Reviewing someone else's fix (including your own from an earlier session)
carries the same bar: "it looks correct," "this is probably just timing,"
and "this doesn't need a test" have each turned out to be wrong here when
someone actually reproduced it, including a "0 flakes under load" claim
that was false under load.

## Commit messages and PRs

This isn't generic advice — it's a description of what's already in `git
log` on this repo, matched deliberately. A good commit message here:

- **States the symptom with evidence**, often a real CI run id or a specific
  test name: *"CI run 34471160876 failed on macOS only: 'a fractional
  endHour is rejected as a config error' ... threw 'no canvas <id>' from
  openConnection instead of the expected error outcome."*
- **Names the root cause precisely**, with the actual function/line
  involved, not "fixed a bug": *"`awaitRecord` returns `CanvasRecord | null`
  on timeout; `openConnection` throws `no canvas ${id}` whenever
  `readRecord` finds nothing"*.
- **Says what was verified, not just what was changed**: *"Verified the
  mechanism with a deterministic repro (delayed writeRecord racing a short
  awaitRecord window) reproducing the exact 'no canvas <id>' error,
  confirming the null-check turns it into a clear diagnostic. Full suite: 0
  failures across 5 consecutive runs."*
- **Doesn't overclaim relative to the diff.** If only two of four call sites
  with the identical bug got fixed, the message says so and says why (e.g.
  "found while auditing every call site for the pattern fixed in the
  previous commit... fixing only the two files named in the bug report
  would leave two more sitting on the same landmine").
- Uses a `type(scope): summary` subject line (`fix(test): ...`,
  `feat(form): ...`, `build: ...`, `docs: ...`) under ~70 chars, with the
  "why", not just the "what," in the body.

A rebuilt `canvas/dist/cli.js` (when `canvas/src/` changed) is its own
commit, `build: regenerate the bundle after <what>` — never folded silently
into the source commit, so `git log` shows source and artifact changes as
separate, reviewable steps.

## Before opening a PR

- [ ] **Focused**: one canvas kind, one bug, or one script — not a grab bag.
- [ ] **The shell/view/validator split is intact** for anything canvas-shaped:
      the view has no IPC/`Escape` handling, the validator is a pure
      function both the shell and (if relevant) `dashboard` can call.
- [ ] **Tested at the right level**: a render snapshot for what it looks
      like, a real-socket IPC test for what it reports back, and — if you
      touched validation — explicit config-error test cases (the display
      scenario's missing `startHour`/`endHour` validation shipped and went
      unnoticed for a while specifically because meeting-picker had this
      coverage and display didn't).
- [ ] **Skill doc kept honest**: if you added, removed, or renamed a kind,
      or changed a keybinding/config field/outcome shape a `SKILL.md`
      documents, update that doc in the same PR. `bun run lint:skills`
      catches a missing/orphaned doc; it does not catch a stale claim inside
      one that still exists — read the doc against the diff yourself.
- [ ] **`bun x tsc --noEmit` and `bun test` pass locally** before pushing —
      CI runs the identical commands on all three OSes and won't tell you
      anything new if these already pass here.
- [ ] **`canvas/dist/cli.js` rebuilt if `canvas/src/` changed** (`bun run
      build`, then commit the result) — `bun run build:check` fails CI
      otherwise, and it's the whole reason `/plugin install` needs no setup.
- [ ] **Fix actually verified**, per "Verifying a fix" above, not just
      "read correctly."
