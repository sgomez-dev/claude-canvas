# Claude Canvas — Roadmap

Planning document for taking this fork from proof of concept to a tool that
earns daily use. Written 2026-09-07.

The upstream repo is an unsupported proof of concept. This roadmap records what
we decided to change, in what order, and why — plus the ideas we deliberately
deferred so they do not get lost.

## Phase decomposition

Four sub-projects. The order is forced by dependencies, not preference.

### Phase 1 — Foundations: one IPC, running on any OS

**Status: complete, with two defects that escaped it** — corrected 2026-09-08,
see the Phase 2 ledger's audit section. All 18 tasks landed and `tsc --noEmit`
reported 0 errors, but the "124 pass / 0 fail" recorded at the time held only
on the machine it was measured on: **CI was red at the very commit that
declared Phase 1 complete**, and had never been green since the 3-OS matrix
landed in Task 18.

1. `Bun.Socket.write()` returns fewer bytes than offered under backpressure;
   `server.ts` and `client.ts` both discarded the return value, so every frame
   larger than the socket send buffer was silently truncated (measured:
   327,212 of 4,000,000 bytes). Failed on ubuntu and macOS, passed on Windows,
   whose loopback buffers absorb 4 MB in one call — which is why the machine
   the code was written on never saw it.
2. `meeting-picker-view.tsx` rendered its clock through `toLocaleTimeString([])`,
   whose locale Bun resolves from the host, so the committed snapshot baseline
   matched no CI leg.

Both fixed (158e74a, a8e9b4b). The lesson worth keeping: a green local run on
one OS is not evidence, and the matrix existed but nothing was reading it.

The bottleneck for everything else. Two problems that turn out to be one
decision: choosing how a canvas talks to Claude *is* choosing the transport,
and the transport is what currently ties the project to Unix.

Scope:

- Unify the IPC on **canvas-as-server**. Delete the controller-as-server model
  (`use-ipc.ts`) and `src/api/`.
- Cross-platform transport and canvas host (Windows native + macOS + Linux).
- Close the command injection in `spawnCanvas`.
- Register the `flight` canvas, which is missing from the scenario registry.
- Migrate all three existing canvases (`calendar`, `document`, `flight`) as-is.
- Tests and CI, written first — not a later phase.

### Phase 2 — Generic primitives

**Status: complete** as of 2026-09-08. All four primitives — `picker`, `form`,
`table`, `diff` — are implemented, wired into `KNOWN_KINDS`, the scenario
registry and `renderCanvas`, and each has render snapshots, real-socket IPC
tests and a `SKILL.md`. `bun test` is 211 pass / 0 fail and `tsc --noEmit` is
clean.

Getting there needed more than finishing the last two: the implementation work
had landed on `worktree-phase2-primitives` and never reached `main`, `form` was
committed without any wiring or tests, `table` did not exist despite two commit
messages claiming it, and no ledger was kept. See
`docs/superpowers/2026-09-08-generic-primitives-progress.md` for the audit, the
rulings, and **nine known gaps** — of which gap 1 (outcomes are not buffered,
so a selection made before `wait` connects is lost and a config error is never
observable by Claude) is the most consequential open defect in the project and
should be closed before Phase 3.

Reusable canvases instead of domain-specific demos. This is where the everyday
value lives.

### Phase 3 — Richer canvases

Depends on Phase 2, because new canvases should *compose* primitives rather
than be 600 bespoke lines like `flight` is today. See the backlog below.

### Phase 3 — entry conditions

Recorded here because Phase 2 uncovered them and Phase 3 depends on them:

**Done as of 2026-09-08** — six of the Phase 2 ledger's nine gaps are
closed, which is what these entry conditions were asking for:

- Outcomes are retained and persisted, so a result can no longer be lost to
  a timing race (3d7dab5). `spawn` also waits for reachability.
- The scenario registry is real: `--scenario` is validated against it, a
  `scenarios` verb reports each scenario's `interactionMode`, and the fields
  nothing read were deleted (this commit). Two defects fell out — every kind
  defaulted to `"display"`, and the calendar's `display` scenario had no IPC
  server at all.
- `markdown-renderer.tsx` and the duplicated types are gone: 885 deletions
  (c9b3c9e). That exposed `DocumentConfig.diffs` as a documented feature
  nothing implemented; removed, pointing at the `diff` canvas instead.
- `FrameDecoder` is linear rather than quadratic (8f42921), which was the
  stated precondition for screenshot work.
- The pane-opening path has execution behind it (b9b3ae8), via
  `canvas/scripts/smoke.sh`.
- Live server-push works: an `update <id>` verb exists and all four
  primitives implement `onUpdate`. That was the capability cited when TCP
  was chosen over files-plus-polling, and it had never been invocable.

**Still open before Phase 3:**

- **`table` measures column width in UTF-16 code units**, so CJK and emoji
  misalign. `Intl.Segmenter` is built into Bun and needs no dependency.
- **The calendar meeting-picker overflows vertically at 70x18**, overlapping
  its own help bar. A Phase 1 layout defect, unrelated to the clock fixes
  that touched those lines.
- **Verify Sixel in Windows Terminal** before committing to a graphics
  protocol, as already noted below.

The pane-opening path is no longer unverified: tmux 3.7c was installed on
2026-09-08 and all four primitives were driven end to end in a real pane
(spawn, render, keys, outcome through `wait`). 4 pass, 0 fail. Windows
Terminal's `split-pane` remains analysis-only.

### Phase 4 — Publishing

Depends on 1 and 2 being real. Docs, versioning, marketplace, contributions.
Reuse the conventions already established in the `claude-skills` repo:
`install.sh` / `install.ps1`, `scripts/test-runner.sh`,
`scripts/lint-permissions.sh`, and the GitHub Actions workflows.

## Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Target environment | Windows native **and** Unix | Windows is the primary dev machine; keep parity with upstream. |
| IPC server role | The **canvas** is the server | Claude interacts through short-lived shell calls that must return. The long-lived process is the TUI, not the controller. The controller-as-server model in `src/api/` blocks for up to 5 minutes waiting for a selection; the Claude Code Bash tool caps at 120s by default and 600s maximum. |
| `src/api/` | Delete, do not repair | Its premise is wrong, not just its code. It also does not compile: it passes `onConnect`/`onDisconnect` to `createIPCServer` (which expects `onClientConnect`/`onClientDisconnect`), calls a non-existent `server.send()`, and documents a `bookFlight` that was never implemented. |
| Transport | TCP on `127.0.0.1`, ephemeral port | Identical on every platform with no per-OS branches, and no reliance on undocumented Bun behaviour. Critically, it is testable without tmux or Windows Terminal — which is what makes CI possible at all. |
| Transport authentication | Registry file + token | Loopback TCP is open to any local process, so the token is required. Authentication is missing entirely today regardless. |
| Canvas discovery | One registry file per canvas id | Holds `{id, kind, scenario, port, token, pid, startedAt}` in the user data directory. One file per canvas rather than a shared one, so concurrent canvases cannot race on writes. |
| Canvas host | `CanvasHost` interface with runtime detection | Backends: `tmux` and `wt` (Windows Terminal `split-pane`). Both verified by spike on 2026-09-07. If neither is detected, `detectHost()` throws `NoHostError` — there is no new-window fallback backend. |
| Spawning | argv as an array **plus** a strict whitelist on `id`/`kind`/`scenario` | argv arrays alone are **not** sufficient: `wt.exe` re-parses its own command line and splits on `;` even inside a correctly quoted argv element, so a whitelist of `^[A-Za-z0-9_-]{1,64}$` is what actually closes the hole on Windows. |
| Pane lifecycle | The canvas exits 0 by itself; the tool never kills it | `wt.exe` has no pane handle and no close verb, and killing the process leaves a zombie pane that no command can remove. So closing must be an IPC request, and exiting non-zero is a defect. |
| Existing canvases | Migrate all three unchanged | They are the honest test that the foundations hold. Whether `flight` deserves to exist is a Phase 3 question. |

### Transport alternatives considered and rejected

- **Unix socket / named pipe with a path abstraction.** More elegant — no
  ports, no token, filesystem permissions do the authentication. Rejected
  because it bets on `Bun.listen({unix})` accepting Windows pipe names, which
  appears only in the Bun source (`src/runtime/socket/WindowsNamedPipe.rs`
  describes named pipes as a drop-in replacement for Unix domain sockets) and
  not in its public contract. Not a bet worth placing in the foundation. Note
  that the current `/tmp/canvas-${id}.sock` paths are invalid on Windows either
  way, so the path abstraction would be needed regardless.
- **Files plus polling.** Unbreakable and trivial to debug, but adds latency
  and write races, and gives up server-push to the canvas — which live
  `update` needs.

## Backlog — deferred to Phases 2/3

Raised during design. Decisions deliberately postponed to the relevant
implementation phase; captured here so the reasoning survives.

### Project preview and mockups

Four distinct ideas with very different difficulty:

1. **Project dashboard (text).** File tree, git status, test results, coverage,
   TODOs. No images, no terminal dependencies, works everywhere. Cheapest to
   build and the most likely to see daily use.
2. **Screenshot of the running app.** Claude builds UI and cannot currently see
   it. Capture the dev server with Playwright (already available as an MCP) and
   paint it in the pane. High value, fidelity limited by the terminal.
3. **Figma / Pencil mockups.** Pull designs from the Figma or Pencil MCPs into
   the pane to compare design against implementation. Most ambitious, most
   dependent on image rendering.
4. **Interactive diff reviewer.** Step through changes hunk by hunk and approve
   or reject each one from the pane. Pure text, and arguably the single most
   frequent interaction anyone has with Claude Code.

### Rendering images in a terminal

Two approaches, and the sane design uses both:

- **Terminal graphics protocols** (Kitty, iTerm2, Sixel) give pixel fidelity
  but depend on the terminal. **Sixel support in Windows Terminal must be
  verified before committing to this.**
- **Coloured half-blocks** (`▀` with foreground/background colours) work in any
  terminal at low fidelity.

Use half-blocks as the universal baseline and a graphics protocol when
available.

### Constraints these ideas place on Phase 1

Known now so the foundations do not have to be redone later:

- **Payload size.** Calendar text is bytes; a screenshot is megabytes. This
  confirms TCP (real streaming, no message size ceiling) and means the protocol
  needs **length-prefixed framing**, not the newline-delimited JSON used today.
- **Capability detection.** If a pane is going to paint images, the host must
  report what the terminal can do, not just how to open a pane. That is an
  additional field on the `CanvasHost` interface.

### Debt Phase 1 knowingly leaves for Phase 2

**Reuse detection is not implemented.** The design's lifecycle section
originally stated, as an invariant, that a canvas is reused when its pid is
alive and still a child of the current terminal (referencing `wtSession`).
That was never built: `wtSession` is written to the registry record but read
nowhere, and `runSpawn` has no liveness check at all. Spawning twice with the
same `--id` silently overwrites the first pane's registry record — the
original pane's port and token are gone from the registry, so `close` can
never reach it again, and it is orphaned for the life of the process. Final
whole-branch review, 2026-09-08. Deferred to Phase 2; see the corrected note
in `docs/superpowers/specs/2026-09-07-canvas-foundations-design.md`'s
lifecycle section.

### Debt Phase 1 knowingly leaves for Phase 3

**`FrameDecoder` re-concatenates its whole buffer on every chunk.** Found by
the Task 4 review, 2026-09-07, and deliberately left in place. Every `push`
allocates a new buffer sized to everything received so far and copies the prior
contents into it, and frame completion copies the remainder again. That is
O(n²) in the number of chunks: a 16 MB frame arriving in 64 KB pieces costs
roughly 2 GB of copying.

It is not a correctness defect — the framing itself reviewed clean, including
`DataView` offsets, aliasing, endianness, and ceiling-before-allocation — and
it is invisible in Phase 1, whose payloads are kilobytes of calendar config and
document text. The 16 MB ceiling exists for the screenshots described above,
and screenshots are exactly the case that meets this cost.

**Fix it before any screenshot work lands**, by buffering incoming chunks in a
list and concatenating once, when a frame is known to be complete, rather than
eagerly on arrival.

Measured 2026-09-08 rather than estimated: a 4 MB frame costs 39 ms in 16 KB
chunks, 15 ms in 64 KB chunks, 7 ms in 256 KB chunks. So the real cost is an
order of magnitude below the 2 GB-of-copying estimate above, and this is not
urgent. Note that the 4 MB integration test's failure was **not** this — it was
the send-side truncation described in Phase 1's status. `socket-writer.ts`,
added by that fix, deliberately avoids the same pattern outbound by queueing
views instead of one growing buffer; the same shape is what `FrameDecoder`
needs inbound.

## Findings from the initial review

Recorded for traceability. Items 1-4 come from reading the code; they were not
reproduced at runtime, since neither Bun nor tmux is installed on the review
machine.

1. **Split-brain IPC — the documented spawn path only works for `document`.**
   `document.tsx:45` uses `useIPCServer` (canvas is the server), which works
   because `cli.ts` connects to it as a client. But `flight.tsx:66` and
   `calendar/scenarios/meeting-picker-view.tsx:60` use `useIPC` (canvas is a
   client expecting a controller server), and `cli.ts spawn` never starts that
   server. `connectWithRetry` exhausts its 10 retries, `clientRef` stays `null`
   (`use-ipc.ts:78`), and `sendSelected` becomes a silent no-op: **user
   selections never reach Claude in two of the three canvases.** The
   `console.error` on failure also writes over the Ink render.
2. **`src/api/` is broken and does not compile** — see the decisions table.
   All three skills instruct Claude to import it.
3. **The `flight` canvas is not in the registry.** `scenarios/registry.ts`
   registers calendar and document; flight has no entries, so
   `getScenario("flight", "booking")` returns `undefined`.
4. **Command injection in `spawnCanvas`.** `terminal.ts:47-57` interpolates
   `kind`, `id` and `scenario` unescaped into a shell string passed to tmux
   `split-window` / `send-keys`. An `--id` containing `;` executes arbitrary
   commands. Socket paths are also predictable, in world-writable `/tmp`.
5. **Unix-only by design.** Unix domain sockets, `/tmp` paths, a bash-shebang
   `run-canvas.sh`, and `tmux split-window`. None of it runs on Windows.
6. **No tests, no CI, no lockfile.** `canvas/CLAUDE.md` advertises `bun test`
   but no test exists, and there is no `.github/`. The lockfile was removed in
   `d5e1548`; a `bun.lock` was regenerated on 2026-09-07 by running
   `bun install` (Bun 1.4.2) and should be committed.
7. **The canvases are demos, not tools.** `flight` is flight booking with fake
   data. The real leverage is generic primitives — hence Phase 2.
8. **Oversized files.** `markdown-renderer.tsx` 775 lines,
   `meeting-picker-view.tsx` 607, `calendar.tsx` 585.
9. **The repo has never passed a typecheck: 113 errors**, verified by running
   `tsc --noEmit` on 2026-09-07 with Bun 1.4.2. Roughly 98 are
   `noUncheckedIndexedAccess` violations, 13 are `Cannot find namespace 'JSX'`
   (React 19 removed the global `JSX` namespace in favour of `React.JSX`), and
   3 are in the dead `src/api/`. Concentrated in the render files, worst being
   `markdown-renderer.tsx` with 37. **Decision: all 113 are fixed in Phase 1**,
   guarded by render snapshots captured before the fixes. See the spec for
   sequencing.
