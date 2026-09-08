# Canvas Plugin Development

Use Bun for all development:

- `bun run src/cli.ts` - Run CLI
- `bun test` - Run tests
- `bun install` - Install dependencies

## Structure

```
canvas/
├── src/           # TypeScript source code
│   ├── cli.ts     # CLI entry point
│   ├── canvases/  # Canvas components (React/Ink)
│   ├── scenarios/ # Scenario definitions
│   ├── runtime/   # IPC protocol, client/server, registry, validation
│   └── host/      # Terminal host backends (tmux, Windows Terminal)
├── skills/        # Skill documentation
├── commands/      # User commands
└── package.json   # Plugin dependencies
```

## Adding a New Canvas Type

A new kind must be registered in **three** places, not one. Miss the first
and `spawn` rejects a correctly-spelled kind at the validation gate built to
catch typos.

1. Add the kind to `KIND_DEFAULT_SCENARIO` in `src/cli.ts`, mapped to the
   scenario it should use when `--scenario` is omitted
2. Create the component in `src/canvases/` and add a `case` to
   `renderCanvas`'s switch in `src/canvases/index.tsx`
3. Register its scenarios in `src/scenarios/registry.ts` (and re-export from
   `src/scenarios/index.ts`)
4. Add a skill in `skills/[name]/SKILL.md`
5. Update the main canvas skill, `README.md` and `commands/canvas.md`
6. Add a render snapshot and a real-socket IPC test

A test in `cli.test.ts` pins the invariant between steps 1 and 3 -- every
kind's default scenario must be registered, and every registered kind must
be known to the CLI. That invariant is what a bare kind list lacked: every
kind used to default to `"display"`, so `spawn flight` ran with a scenario
flight does not have.

**Every canvas must call `useCanvasServer` when `enabled`.** A canvas
without a server writes no registry record, so it cannot be listed, read or
closed -- `close` answers "no canvas <id>" for a pane sitting right there,
against the lifecycle design that requires closing to be an IPC request.
The calendar's `display` scenario was missing this until 2026-09-08.

## Canvas anatomy: view, shell, validator

Since Phase 3, a primitive canvas is **three** files, and the split is what
makes composition possible:

```
canvases/<kind>.tsx           the canvas shell
canvases/<kind>/view.tsx      the view
canvases/<kind>/validate.ts   the validator
```

- **The shell** owns the live config, the IPC server, `Escape`, and the
  single outcome. It mounts its own view with `focused` permanently true.
- **The view** owns rendering and local interaction and knows nothing about
  IPC, registry records or outcomes. It gates its keys on
  `useInput(handler, { isActive: focused })`, and takes a `rows`/`budget`
  prop for the height it may paint into — the terminal height standalone,
  or a region's allotment inside a composed canvas.
- **The validator** is a pure function both the shell and any composing
  canvas call, so a bad region config is reported exactly as a bad canvas
  config is.

Three rules that are load-bearing rather than stylistic:

1. **A view must never handle `Escape`.** It belongs to the shell, always
   active. A view that swallowed it would make a composed canvas
   un-exitable through whichever region happened to be focused, and it must
   also work from the config-error state where no view is mounted at all.
2. **A view must not guard its own double submit.** `onSubmit` may fire more
   than once; the shell enforces first-outcome-wins, because the outcome is
   the shell's to own.
3. **Reset by remounting the view**, keyed on a `generation` counter the
   shell bumps on every pushed config — not by clearing state by hand. A
   pushed config is a new question, and `form`'s values are keyed by field
   id while `diff`'s decisions are keyed by hunk id, so a missed reset
   misattributes an answer silently.

`dashboard` is the composed canvas: it allocates rows between regions, owns
`Tab` as well as `Escape`, and tags its outcome with the `regionId` that
produced it. Adding a region kind means adding a case to
`dashboard/validate.ts`'s `validateRegionConfig` and one to
`dashboard.tsx`'s `renderRegion`.

## Scenarios

`--scenario` is validated against the registry, not just for identifier
shape. `getScenario(kind, name)` backs that check and `listScenarios(kind)`
backs the `scenarios` CLI verb, which reports each scenario's
`interactionMode` so a controller knows whether to expect a result at all.

`ScenarioDefinition` carries only what something reads: `name`,
`description`, `canvasKind`, `interactionMode`. It used to also carry
`closeOn`, `autoCloseDelay` and `defaultConfig` (plus two generic
parameters that existed only to type the last one); nothing read any of
them, every canvas hardcodes its own closing behaviour and defaults, and a
field that describes behaviour without causing it reads as a contract to
whoever finds it next.

## IPC Protocol

The CLI (`cli.ts`) talks to a running canvas over a length-prefixed JSON
frame protocol on a local TCP socket (`src/runtime/protocol.ts`,
`client.ts`, `server.ts`). Each command speaks a small message set and
prints one JSON result on stdout:

```typescript
// Controller → Canvas
{ type: "hello", token }     // authenticate onto the canvas's socket
{ type: "update", config }   // push new config (CLI: `update <id>`)
{ type: "get", key }         // read state (selection, content, config)
{ type: "close" }            // ask the canvas to exit
{ type: "ping" }             // health check

// Canvas → Controller
{ type: "hello-ok" }
{ type: "error", message }
{ type: "ready", scenario, capabilities }
{ type: "value", key, data }
{ type: "selected", data }
{ type: "cancelled", reason? }
{ type: "pong" }
```

`ready` is retained and replayed to each controller as it authenticates, so
it is genuinely observable. It used to be broadcast the instant the server
came up — before any controller could have read the port from the registry
record — and therefore reached nobody.

**A controller must not assume the first frame it receives is its outcome.**
On authenticating it is sent `ready`, and then any outcome the canvas has
already produced. `waitForOutcome` skips non-outcome frames; so does the
`nextOutcome` helper the tests use.

**Outcomes are retained and persisted.** A canvas produces exactly one
terminal outcome (`selected`, `cancelled` or `error`) — the first call wins
and later ones are dropped, so a controller can never read one of two
contradictory answers. The outcome is written synchronously into the
registry record *before* it is broadcast and before the canvas exits, and
the record deliberately outlives the process while the outcome is unread.
`waitForOutcome` checks the record first, consumes it, and deletes it. That
is what makes the documented `spawn` → `wait` flow correct regardless of
timing: a choice made before `wait` connects, or after the canvas has
already exited, still reaches Claude.

`spawn` does not report success until the canvas is reachable — it waits for
the registry record rather than returning the moment the pane opens.

**Live updates.** `update <id> --config <json>` (or `--config-file`) pushes a
new config into a running canvas. All four primitives and `document`
implement `onUpdate`; the four primitives **reset their interaction state**
when one arrives, because a pushed config is a new question: a cursor can
point past the new content, and `form`'s values and `diff`'s decisions are
keyed by field and hunk id, so carrying them over could apply an answer to
something the user never saw. `pushUpdate` waits for the writer to drain
before closing, so a multi-megabyte config is not truncated.

`wait <id>` polls this connection and surfaces one outcome per call:
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

Host backends (`src/host/`) open the canvas in a new pane: `tmux` or
Windows Terminal, whichever is detected (`detectHost()`).
