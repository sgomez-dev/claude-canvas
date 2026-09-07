# Claude Canvas — Roadmap

Planning document for taking this fork from proof of concept to a tool that
earns daily use. Written 2026-09-07.

The upstream repo is an unsupported proof of concept. This roadmap records what
we decided to change, in what order, and why — plus the ideas we deliberately
deferred so they do not get lost.

## Phase decomposition

Four sub-projects. The order is forced by dependencies, not preference.

### Phase 1 — Foundations: one IPC, running on any OS

**Status: in design.**

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

Depends on Phase 1. Reusable canvases instead of domain-specific demos:
`picker`, `form`, `table`, `diff`. This is where the everyday value lives.

### Phase 3 — Richer canvases

Depends on Phase 2, because new canvases should *compose* primitives rather
than be 600 bespoke lines like `flight` is today. See the backlog below.

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
| Canvas host | `CanvasHost` interface with runtime detection | Backends: `tmux`, `wt` (Windows Terminal `split-pane`), and a new-window fallback. Both verified by spike on 2026-09-07. |
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
