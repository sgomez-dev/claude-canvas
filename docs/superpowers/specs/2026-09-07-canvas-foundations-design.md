# Canvas Foundations — Design

**Phase 1 of the roadmap in [`docs/roadmap.md`](../../roadmap.md).**
Date: 2026-09-07.

## Problem

Claude Canvas gives Claude Code its own display: React/Ink TUIs in a pane that
talk to Claude over IPC. The idea works. The foundation does not.

Three problems, and they are one problem:

1. **The IPC has a split brain, and the documented path only works for one of
   the three canvases.** `document.tsx:45` uses `useIPCServer` — the canvas is
   the server, and `cli.ts` connects to it as a client. That works. But
   `flight.tsx:66` and `calendar/scenarios/meeting-picker-view.tsx:60` use
   `useIPC` — the canvas is a *client*, expecting a controller-side server that
   `cli.ts spawn` never starts. `connectWithRetry` exhausts its 10 retries,
   `clientRef` stays `null` (`use-ipc.ts:78`), and `sendSelected` silently does
   nothing. **User selections never reach Claude in two of three canvases.**
2. **There is no way for Claude to wait for a selection at all.** No CLI verb
   blocks on one. Even the canvas that has working IPC cannot deliver an
   interaction result on the documented path.
3. **None of it runs on Windows.** Unix domain sockets, `/tmp` paths, a
   bash-shebang `run-canvas.sh`, and `tmux split-window`. Windows is the primary
   development machine for this fork.

Choosing how a canvas talks to Claude *is* choosing the transport, and the
transport is what ties the project to Unix. One decision fixes all three.

Secondary defects folded in because this work touches the same code:

4. **`src/api/` does not compile** and is what all four skills instruct Claude
   to import. `createIPCServer` is `async` and returns `Promise<IPCServer>`,
   which `canvas-api.ts` never awaits — hence `Property 'close' does not exist
   on type 'Promise<IPCServer>'` (`canvas-api.ts:49`) and the same for `send`
   (`:123`). Its `onMessage` is also typed backwards, taking `CanvasMessage`
   where `ControllerMessage` is expected (`:57`). Separately it passes
   `onConnect`/`onDisconnect` where `createIPCServer` expects
   `onClientConnect`/`onClientDisconnect` (`ipc/server.ts:8-13`), and it
   documents a `bookFlight` that was never implemented.
5. **Command injection in `spawnCanvas`.** `terminal.ts:47-57` interpolates
   `kind`, `id` and `scenario` unescaped into a shell string handed to tmux
   `split-window` / `send-keys`. An `--id` containing `;` runs arbitrary
   commands.
6. **The `flight` canvas is not in the scenario registry**, so
   `getScenario("flight", "booking")` returns `undefined`.
7. **No tests, no CI, no lockfile.** `canvas/CLAUDE.md` advertises `bun test`;
   no test exists.
8. **The repo has never passed a typecheck: 113 errors.** Verified with
   `tsc --noEmit` on Bun 1.4.2, 2026-09-07. Three distinct causes:

   | Count | Cause |
   |---|---|
   | ~98 | `noUncheckedIndexedAccess` violations (TS2532, TS18048, TS2345, TS2322). The tsconfig enables it alongside `strict`, and the code was never checked against it. Not cosmetic — `Date \| undefined` reaches `new Date()` and comparisons. |
   | 13 | `Cannot find namespace 'JSX'` (TS2503). Not the original author's doing: React 19 removed the global `JSX` namespace in favour of `React.JSX`. Mechanical. |
   | 3 | `api/canvas-api.ts`, which disappear when it is deleted. |

   Concentrated in the render files: `markdown-renderer.tsx` 37,
   `raw-markdown-renderer.tsx` 20, `meeting-picker-view.tsx` 19,
   `seatmap-panel.tsx` 9, `calendar.tsx` 7, `seat-row.tsx` 7,
   `document.tsx` 5, `use-mouse.ts` 3, remainder in `types.ts` files.
9. **`use-mouse.ts` writes to the real `process.stdout`, bypassing Ink.**
   Lines 102 and 155 emit the mouse-tracking enable/disable escapes
   (`\x1b[?1003h\x1b[?1006h` / `…l`) directly. Found while spiking the render
   harness. Two consequences: it escapes any injected stream, and **a canvas
   that dies before its cleanup runs leaves the user's terminal stuck in SGR
   mouse mode.** Mouse control belongs behind the same output path as the rest
   of the render, and needs a cleanup that survives an abnormal exit.
10. **`document.tsx` logs a React duplicate-key warning on every render**
    (`Encountered two children with the same key`). Harmless to output, but it
    will pollute every one of the ~98 refactor test runs, and a duplicate key
    means React's reconciliation of that list is not what the author intended.

## Success criteria

- All three canvases (`calendar` meeting-picker, `document` edit, `flight`
  booking) deliver a user selection back to Claude through the documented CLI
  path.
- The full protocol round-trip is exercised by a test that needs no tmux, no
  Windows Terminal, and no terminal at all.
- CI passes on both `ubuntu-latest` and `windows-latest`.
- A canvas id containing shell metacharacters cannot execute anything, proven
  by a regression test. The test must cover `;` specifically, since that is the
  character that defeats argv arrays on the `wt` backend.
- No canvas ever exits non-zero, including on error paths — enforced by test,
  because a non-zero exit leaves an unremovable pane on Windows.
- `tsc --noEmit` reports zero errors, down from 113.
- Every canvas renders byte-identically to its pre-migration snapshot, except
  where a change was deliberate and the snapshot updated in the same commit.

## Non-goals

- **New canvas types or primitives.** Phases 2 and 3.
- **Image rendering in the pane.** Phase 3. Its two constraints on this phase
  (length-prefixed framing, a capabilities field on the host) are honoured here;
  nothing else.
- **Redesigning the existing canvases.** Their behaviour and layout do not
  change. Their IPC calls are swapped and their type errors are fixed; nothing
  else.
- **Splitting the oversized files** — `markdown-renderer.tsx` (775 lines),
  `meeting-picker-view.tsx` (607), `calendar.tsx` (585). Their *structure* is
  out of scope even though their type errors are in scope. Restructuring them
  here would blend two changes and make regressions untraceable; splitting them
  belongs to whichever later phase has a reason to work in them.

## Architecture

### Server role: the canvas is the server

Claude interacts through short-lived shell calls that must return so it can keep
working. The long-lived process is the TUI in the pane, not the controller.

This kills the controller-as-server model outright. `src/api/`'s
`spawnCanvasWithIPC` blocks for up to 5 minutes awaiting a selection; the Claude
Code Bash tool caps at 120s by default and 600s maximum. Its premise is wrong,
not just its code, so it is **deleted rather than repaired**.

### Transport: TCP on 127.0.0.1, ephemeral port

The canvas listens on `127.0.0.1:0`. Chosen because it behaves identically on
every platform with no per-OS branches, relies on no undocumented Bun
behaviour, and — decisively — is testable without a terminal, which is what
makes CI possible at all.

Rejected alternatives, with reasons, are recorded in
[`docs/roadmap.md`](../../roadmap.md#transport-alternatives-considered-and-rejected).

The cost is that loopback TCP accepts any local process, so a token is
required. Authentication is absent today regardless.

### Protocol

**Framing: `<uint32 big-endian length><JSON payload>`.** The current code
buffers and splits on `\n` (`ipc/server.ts:38-40`), which breaks on any payload
containing a newline and scans every byte. Length prefixing also carries the
megabyte payloads Phase 3 will need.

**Handshake.** The client's first frame must be `{type:"hello", token}`.
Mismatch or absence closes the connection. This is what makes loopback TCP
acceptable.

**Messages.**

| Controller → canvas | Canvas → controller |
|---|---|
| `hello {token}` | `hello-ok` \| `error {message}` |
| `update {config}` | `ready {scenario, capabilities}` |
| `get {key}` | `value {key, data}` |
| `close` | `selected {data}` |
| `ping` | `cancelled {reason?}` |
| | `pong` |

`get`/`value` replaces today's `getSelection` and `getContent`, which are
`document`-specific concerns leaked into the generic layer. Two fewer message
types, and a new canvas can expose state without touching the protocol.

**Keys are canvas-defined**, not protocol-defined. `document` answers
`selection` and `content`; every canvas answers `config`. An unknown key
returns `value {key, data: null}` rather than an error, so a controller can
probe without special-casing per canvas.

**Frame size ceiling: 16 MB.** A frame declaring more is rejected and the
connection closed, so a corrupt or hostile length prefix cannot make the canvas
allocate unboundedly. Generous enough for the Phase 3 screenshots.

`selected` and `cancelled` stay explicit. Generalising them into an `event`
envelope would be speculation — they are the central interaction.

### Waiting for a selection

`canvas wait <id>` blocks up to 55 seconds and returns either the selection or
an explicit `pending` status. The 55s is chosen so the call always returns
inside the Bash tool's 120s default, leaving Claude to decide whether to wait
again.

Polling via `get` alone is insufficient: a selection made between two polls
would be lost.

**Every CLI command prints a single JSON object on stdout**, because Claude
parses it. `wait` yields exactly one of:

```jsonc
{ "status": "selected",     "data": { /* canvas-defined */ } }
{ "status": "cancelled",    "reason": "escape" }
{ "status": "pending" }        // timeout elapsed, canvas still alive
{ "status": "disconnected" }   // canvas died while waiting
{ "status": "error",        "message": "..." }
```

Exit code is 0 for `selected`, `cancelled` and `pending` — all three are
successful outcomes of asking — and 1 for `disconnected` and `error`. Human-
readable diagnostics go to stderr so they never corrupt the parsed object.

### Discovery: one file per canvas

`<dataDir>/claude-canvas/canvases/<id>.json` holding
`{id, kind, scenario, port, token, pid, startedAt, host, wtSession?, lastError?}`.

`host` names the backend that opened the pane. `wtSession` is the pane's
`WT_SESSION` guid on Windows — note it is **per-pane, not per-window**, so it
identifies the canvas pane specifically. `lastError` carries a failure reason,
because a canvas must exit 0 even when it fails (see the lifecycle section) and
therefore cannot signal through its exit code.

One file per canvas rather than a shared registry, because a shared registry
would have concurrent-write races between simultaneous canvases — exactly the
failure mode to design out.

`dataDir` resolves per platform: `LOCALAPPDATA` on Windows,
`XDG_STATE_HOME` or `~/.local/state` on Linux, `~/Library/Application Support`
on macOS. This removes `/tmp` from the codebase, which is half of why nothing
runs on Windows. Mode `0600` on Unix.

**Stale entries:** on read, `process.kill(pid, 0)` checks liveness and unlinks
dead entries. A fragile version of this exists for the tmux pane id
(`terminal.ts:66-85`) and nothing exists for sockets.

**Token:** 32 random bytes, hex.

### Host: opening the pane

```ts
interface CanvasHost {
  name: string
  isAvailable(): boolean
  capabilities(): TerminalCapabilities
  open(spec: PaneSpec): Promise<PaneHandle>
}

type PaneSpec = { argv: string[]; title: string; ratio: number }

type TerminalCapabilities = {
  graphics: "kitty" | "iterm2" | "sixel" | "none"  // Phase 3 consumes this
  trueColor: boolean
  mouse: boolean
  columns: number
  rows: number
}
```

Three backends, detected at runtime: `tmux` when `$TMUX` is set, `wt`
(Windows Terminal `split-pane`) when `$WT_SESSION` is set, and a new-window
fallback.

`capabilities()` ships now despite having no Phase 1 consumer, because it is a
field on an interface — adding it later means revisiting all three backends.
Phase 1 implements only what is free: `columns`/`rows` from the terminal size,
`trueColor` and `mouse` from `$COLORTERM` and `$TERM`. **`graphics` returns
`"none"` unconditionally.** Probing for Kitty, iTerm2 or Sixel support is
Phase 3 work and must not be attempted here.

**Verified commands (spike, 2026-09-07):**

- tmux: `["tmux","split-window","-h","-l","67%","--", ...argv]`. The current
  `-p 67` is deprecated in modern tmux in favour of `-l 67%`.
- Windows Terminal: `["wt.exe","-w","0","split-pane","-V","--size","0.66", ...argv]`.
  Confirmed against Windows Terminal 1.24.11911.0 — it splits the user's
  existing window in place, with the new pane taking ~2/3 of the width.

**`-w 0` is mandatory.** Without it `wt` opens a brand new window
(`windowingBehavior` defaults to `useNew`). `-w last` targets the
most-recently-*used* window, which is not necessarily the caller's — unsafe.
`-V` is the side-by-side split; verified by geometry rather than documentation
(the caller's pane went 170x43 → 55x43, so width shrank and height did not).
`--size` applies to the *new* pane. Pin the profile with `-p`, since a split
otherwise launches the default profile, whose font metrics differ.

### Closing the injection — argv arrays are necessary but not sufficient

An earlier draft of this design claimed argv arrays remove the injection by
construction. **That is true for tmux and false for `wt`.** The spike
established that `wt.exe` re-parses its own raw command line and splits on `;`
**even when the semicolon sits inside a single, properly quoted argv element**.
One `-Command` argument containing three semicolons was shredded into four
separate `wt` commands, each opening its own tab (the implicit default
subcommand being `new-tab`), and only the first fragment ran.

So `;` is an injection vector into `wt`'s own command grammar regardless of
quoting. Three layers, all required:

1. **argv as an array, never a shell string.** Necessary everywhere; sufficient
   for tmux.
2. **Validate `id`, `kind` and `scenario` against `^[A-Za-z0-9_-]{1,64}$` at the
   CLI boundary**, rejecting anything else. These are the only user-controlled
   values that reach a host argv, and the whitelist excludes `;` along with
   every other metacharacter. This is the layer that actually protects the `wt`
   backend.
3. **Never route free-form text through a host argv.** Config already travels by
   file (`--config-file`), which is what keeps arbitrary user content out of the
   command line entirely.

**Pane reuse never uses `send-keys`.** It is inherently a shell string
(`terminal.ts:132`), so the vector stays open while it exists. It also carries a
`setTimeout(150)` wait for the previous process to die, which is a race in
disguise. Reuse is handled by the lifecycle protocol below instead.

**Config passes by file, not argv.** `--config-file <path>`, written under
`dataDir`. Necessary rather than cosmetic: Windows caps a command line at
roughly 32 KB, which Phase 3 screenshots would exceed. Replaces today's
`--config "$(cat /tmp/...)"`.

### Pane lifecycle: the canvas owns its own death

`wt.exe` offers **no pane handle and no close verb.** It is a GUI application:
it returns exit code 0 immediately and writes zero bytes to stdout or stderr on
every invocation, `wt --help` included. The complete verb table extracted from
`TerminalApp.dll` is `new-tab`, `split-pane`, `focus-tab`, `focus-pane`,
`move-focus`, `move-pane`, `swap-pane` — every one of them creates or moves.
None destroys. Killing the canvas process does **not** reclaim the pane: with
the default `closeOnExit: automatic`, a non-zero exit leaves a **zombie pane
that cannot be removed from the CLI at all** (verified).

This turns three things from preferences into invariants:

1. **`canvas close <id>` sends the IPC `close` message and never kills a
   process.** The design already routed closing through IPC; the OS now makes
   that the only workable option.
2. **A canvas must always exit 0**, error paths included. A failure is reported
   over IPC and recorded in the registry file before exiting cleanly; the exit
   code is not a channel. Exiting non-zero on Windows creates unremovable UI
   litter, so a non-zero exit is a defect, not a diagnostic.
3. **Reuse detection is by process identity, not pane id.** The registry file
   gains `host` and, on Windows, `wtSession`. A canvas is reusable when its pid
   is alive **and** still a child of the current `WindowsTerminal.exe`;
   otherwise the entry is cleared and a fresh pane is split. This replaces
   `/tmp/claude-canvas-pane-id` (`terminal.ts:63`), which stores a tmux pane id
   that has no Windows equivalent.

tmux does have real pane handles and could close a pane directly, but it
implements the same protocol so that one lifecycle serves both backends.

## Resulting structure

```
src/
├── runtime/   protocol.ts, server.ts, client.ts, registry.ts,
│              paths.ts, use-canvas-server.ts
├── host/      index.ts (interface + detection), tmux.ts,
│              windows-terminal.ts, new-window.ts
├── canvases/  internals unchanged; only IPC calls swapped
└── scenarios/ flight scenarios registered
```

**Deleted:** `src/api/`, `src/ipc/`, `src/canvases/calendar/hooks/use-ipc.ts`,
`use-ipc-server.ts`, `src/terminal.ts`, `run-canvas.sh`.

`run-canvas.sh` goes because argv arrays let the host invoke `bun` directly; it
was a bash-shebang script, so this is one more Unix-only piece removed.

### The single hook

`use-ipc.ts` and `use-ipc-server.ts` merge into `useCanvasServer()`, and move.
Today they sit in `src/canvases/calendar/hooks/`, so `document.tsx:5` and
`flight.tsx:5` import a *calendar* hook — a structural wart the merge resolves
for free.

### CLI surface

| Command | Status |
|---|---|
| `show <kind>` | existing, gains `--config-file` |
| `spawn <kind>` | existing, routed through `CanvasHost` |
| `wait <id> [--timeout]` | **new** — blocks for a selection |
| `get <id> <key>` | **new** — replaces `selection` and `content` |
| `close <id>` | **new** |
| `list` | **new** — live canvases from the registry |
| `env` | existing — now reports chosen host and capabilities |

`close` and `list` are not new features; they are basic lifecycle that was never
implemented. There is currently no way to close a canvas or find out which are
alive. Both fall out of the registry.

## Migration order

1. **Render snapshots of all three canvases, on untouched code.** Must be first;
   see above. The harness is a solved problem as of the 2026-09-07 spike, so
   this step carries no unknowns. Interactive scenarios additionally need
   `process.stdout.write` stubbed for the duration of the test, because of
   defect 9.
2. **Runtime and host, test-first.** No canvas touched yet.
3. **`document`** — already uses the server model, so it validates the new
   protocol with the least change.
4. **`flight`** — flip from client to server; register its scenarios.
5. **`calendar` meeting-picker** — most tangled (mouse plus slot maths), so it
   is the strongest evidence the design holds.
6. **The 113 type errors.** After the migration, so a snapshot diff has exactly
   one plausible cause at a time. Order within the step: delete `src/api/` (3
   errors gone), then the 13 mechanical `JSX` → `React.JSX` renames, then the
   ~98 `noUncheckedIndexedAccess` fixes file by file, running the snapshots
   after each file.
7. **The four `SKILL.md` files.**

### The skills are part of the work

The skills are how Claude learns to use this, and they currently teach it to
import `src/api/` and call a `bookFlight` that does not exist
(`skills/canvas/SKILL.md:90`, `skills/flight/SKILL.md:147`,
`skills/calendar/SKILL.md:130`). Migrating the code without the skills leaves
Claude calling deleted code. They must lose the High-Level API sections and
document `wait`, `get`, `close` and `list`.

## Error handling

**Two different exit-code rules apply, and conflating them is a bug.**

- **A canvas process always exits 0**, because a non-zero exit leaves an
  unremovable pane on Windows. It reports failure by writing `lastError` to its
  registry file and, if the connection is up, sending an IPC `error` — then
  exits cleanly.
- **A controller CLI invocation uses exit codes normally**, since it is a
  short-lived process in Claude's shell with no pane to leak.

Cases:

- **Canvas cannot bind a port** → writes a registry file carrying only
  `{id, lastError}` so the failure is discoverable, renders the error in the
  pane, and exits 0. It must not exit non-zero even here.
- **Controller cannot find a registry file** → `{"status":"error"}` on stdout,
  diagnostic on stderr, exit 1.
- **Registry file exists but the pid is dead** → unlink it, report as not found.
- **Bad or missing token** → server closes the connection; client reports an
  authentication failure.
- **No host available** → the new-window fallback; if that also fails, a clear
  message naming what was tried.
- **Canvas dies mid-wait** → `wait` detects the closed connection and returns
  `disconnected` rather than hanging to timeout.
- **IPC errors must never `console.log`.** Today `use-ipc.ts:63` writes
  `console.error` straight over the Ink render. Canvas-side errors go to a log
  file under `dataDir` and, where useful, into the TUI's own status line.

### Never close a socket in the same tick as a final write

Found during Task 6, 2026-09-07, and measured rather than assumed: writing a
frame and then calling `end()` synchronously **discards the frame** on
Windows/Bun when the peer still has unread inbound data queued. Closing under
that condition produces an OS-level RST, and the RST drops the outbound write
that was still buffered. Isolated outside project code at 33 failures in 40
runs with an immediate close, against 0 in 60 with the close deferred by one
tick.

This is not a test artefact. It affects every send-then-close path in the
design, and there are two:

- The authentication rejection in the canvas server, which must deliver its
  `error` frame before closing or the controller sees an unexplained
  disconnect instead of "authentication failed".
- **`requestClose` in the controller client**, which sends `{type:"close"}` and
  then closes. Losing that frame means the canvas is never asked to exit — and
  since a canvas must exit 0 by itself because nothing can remove a pane
  otherwise, a dropped close message is precisely how a zombie pane appears.

So: defer the close by a tick after a final write, and guard the connection
against processing anything further in that window — the guard matters most on
the rejection path, where the window must not become an opportunity to deliver
a message that authentication just refused.

## Testing

TDD throughout: tests before implementation.

| Layer | Cases |
|---|---|
| Protocol | frame roundtrip; one frame split across 3 chunks; several frames in one chunk; oversized frame rejected; malformed JSON |
| Auth | no `hello` closes; wrong token errors and closes; correct token yields `hello-ok` |
| Registry | write/read roundtrip; dead-pid cleanup; two concurrent canvases do not collide; `0600` on Unix |
| Host | with `$TMUX` / `$WT_SESSION` mocked, assert the backend chosen **and the exact argv**; assert `-w 0` is always present for `wt` |
| Input validation | `id`, `kind` and `scenario` reject `;`, spaces, quotes, path separators and anything outside `^[A-Za-z0-9_-]{1,64}$`, before any argv is built. **This is the injection regression test**, and `;` is its most important case — the one that defeats argv arrays on `wt` |
| Lifecycle | every canvas exit path returns 0, error paths included; a canvas that fails to bind still writes a discoverable `lastError`; reuse detection rejects a dead pid and a pid that is no longer a child of the current terminal |
| Integration | in-process server, real TCP client, full `ready → update → get/value → selected → close` — no tmux, no pane. **This is the test that proves defect 1 is dead.** |
| Render | **Snapshots** of the captured frame for all three canvases across fixture configs, via the in-repo harness described below |

### Render snapshots come first, and they are load-bearing

Fixing 113 type errors means roughly 98 edits inside render code, 57 of them in
two files of 775 and 389 lines. Assertions that merely check some expected text
appears would not catch a subtle visual regression from that many edits.

So the render layer is **snapshot-based**, and its sequencing is part of the
design rather than an implementation detail:

1. Capture `lastFrame()` snapshots of all three canvases against fixture
   configs **while the code is still untouched**. This is the only moment the
   pre-migration rendering exists to be recorded.
2. Do the IPC migration and the type fixes.
3. Any snapshot diff is a regression until proven otherwise.

This is what converts ~98 risky edits into safe ones. If the snapshots are
captured after the fixes, they record the bugs instead of catching them.

### Render harness — verified by spike, 2026-09-07

**No test dependency.** `ink-testing-library@4.0.0` does work with Ink 6, but it
declares no `ink` peer dependency (its devDependency is pinned to Ink 5), and
its `columns` is a readonly getter fixed at `100` while `rows` is `undefined` —
so it cannot snapshot at varying terminal sizes, which is precisely what a
render refactor needs. Internally it is ~40 lines doing what we can do
ourselves. We own a ~25-line harness instead: an `EventEmitter` subclass with
`columns`, `rows` and `write`, passed to Ink's `render()` as `stdout`.

Non-negotiable harness requirements, each established empirically:

| Requirement | Why |
|---|---|
| **A fake `stdin`** with `isTTY = true` and a no-op `setRawMode` | Without it, any canvas using `useInput` renders Ink's *error screen* — `Raw mode is not supported on the current process.stdin` — as a 3443-character frame complete with a React stack trace. **Nothing throws.** `lastFrame()` returns the stack trace and the test passes. This is the single most dangerous failure mode in the whole plan. |
| **`debug: true`** | Otherwise Ink routes through `log-update` and coalesces frames: three sequential renders produced only two writes, the last two merged and laden with cursor escapes. In debug mode it is exactly one full frame per commit, no escapes, no trailing newline. |
| **`FORCE_COLOR=1`, pinned** | Colour output is all-or-nothing and environment-dependent: the same frame went 752 → 1057 characters with colour on, failing the snapshot. `NO_COLOR` does **not** override `FORCE_COLOR`. Pin it to `1` rather than `0`, because a render refactor can change a colour and stripping ANSI would hide exactly the regression we are guarding against. Ink 6 does not downsample, so `1`, `2` and `3` are identical; only `0` differs. |
| **`settle()` awaiting a macrotask** | State set in a mount effect is absent from the synchronous frame *and* after `await Promise.resolve()`. It only appears after a `setTimeout(…, 0)`. |
| **A fresh stdout object per render** | Ink keys instances by the stdout object; reusing one makes the second `render()` rerender the first tree instead of mounting a new root. Always `unmount()` and `cleanup()`. |
| **Explicit small `columns`/`rows`** | Omitting them silently defaults to 80 columns, and canvases pad to fill the height — a trivial 3-line document is ~750 characters at 60x15. Small explicit sizes keep diffs readable. |

Do **not** normalise trailing whitespace: debug frames carry none and do not end
in a newline. Do not assert on line `.length` either — padding is by display
width, so lines containing wide characters legitimately differ in length.

Verified working: the real `document.tsx` rendered correctly, byte-identical
across three consecutive renders, and `bun`'s `toMatchSnapshot()` produced a
human-readable `.snap`. `setSystemTime` composes with it cleanly.

**CI:** GitHub Actions, matrix `ubuntu-latest` + `windows-latest`, running
`bun test` and `tsc --noEmit`. The Windows leg is the point — it is what stops
Unix-only assumptions creeping back. `tsc --noEmit` would have caught the
`src/api/` breakage the day it landed. Structure mirrors
`claude-skills/.github/workflows/test-skills.yml`.

A `bun.lock` is committed; without it CI is not reproducible. It was removed in
`d5e1548`.

## Risks

- ~~Windows Terminal `split-pane` behaviour is unverified~~ **Resolved
  2026-09-07 by spike**, against Windows Terminal 1.24.11911.0. It works; see
  the host section. What the spike changed is the lifecycle model and the
  injection analysis, not the viability.
- **A hard-crashing canvas leaves a zombie pane on Windows, and nothing can
  clean it up.** If the process dies without exiting 0 — an external kill, an
  OOM — the pane persists and no `wt` command can remove it. Accepted for
  Phase 1; the mitigation is that exiting 0 is an enforced invariant rather
  than a convention. A UI Automation sweeper (invoking the pane's
  `CloseButton` automation element) is known to work but is out of scope.
- **Pane indices are the only other addressing `wt` offers, and they are
  fragile.** `wt -w 0 focus-pane -t 1` works, but indices are creation-order
  within the tab and shift as panes open and close. Not used by this design.
  The undocumented `--keychord`/`-k` flag was also tested and rejected: in one
  configuration it spawned a spurious error window on every one of six calls.
- ~~`ink-testing-library` against Ink 6 is unverified~~ **Resolved
  2026-09-07 by spike.** See "Render harness" in the testing section. It works,
  but we are not using it.
- **Migrating the calendar meeting-picker is the largest unknown** — 607 lines
  coupling mouse handling to IPC. Sequenced last among the migrations on
  purpose.
- **Snapshot instability was a real blocker, and is resolved.** Two of the
  three canvases render live clocks, so raw snapshots would never be
  deterministic: `flight/components/cyberpunk-header.tsx:28` renders
  `new Date().toLocaleTimeString()` directly, and `calendar.tsx:367,375-376`
  keeps a `currentTime` state on a `setInterval`. Also
  `meeting-picker-view.tsx:36,143` and `calendar.tsx:113,425` call `new Date()`
  for "today".

  **Mechanism: `setSystemTime` from `bun:test`, pinned in every render
  fixture.** Verified against bun-types 1.4.1 to control `Date.now()`,
  `new Date()` **and `Intl.DateTimeFormat().format()`** — the third is what
  makes it cover `toLocaleTimeString`, without which the flight header would
  stay unpinnable. Pinning the clock also settles the `setInterval` re-renders,
  since a re-render then produces an identical frame.

  No `Math.random()` exists in any canvas, so randomness needs no handling.

  **Pinning the clock is only half of it — the timezone must be pinned too.**
  Found by the Task 1 review, 2026-09-07. `setSystemTime` fixes the epoch
  instant `Date` returns; it does not fix the timezone in which that instant
  is *rendered*, and every one of these canvases renders local time:
  `flight/components/cyberpunk-header.tsx:28` and `flight/types.ts:86-93` call
  `toLocaleTimeString` with no `timeZone` option, `calendar/types.ts:99`
  derives positions from `getHours()`/`getMinutes()`, and
  `meeting-picker-view.tsx:591-595` formats both time and date. Left unpinned,
  every snapshot diverges with no code change as soon as the process timezone
  is not UTC — which is the normal case, since the development machine is in
  CET/CEST and CI runs `ubuntu-latest` and `windows-latest`.

  So the test preload pins `process.env.TZ = "UTC"` alongside `FORCE_COLOR`.
  Verified: the pin in the preload beats an externally forced
  `TZ=Asia/Tokyo`, and removing it reproducibly breaks 3 of 8 tests under that
  same forced timezone — so the pin is demonstrably both effective and
  load-bearing.

  General lesson for later phases: a determinism check that runs the same
  suite twice on one machine cannot detect a dependence on the environment.
  Proving an environment pin works needs a negative control that fights it.
