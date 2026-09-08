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

1. Add the kind to `KNOWN_KINDS` in `src/cli.ts`
2. Create the component in `src/canvases/` and add a `case` to
   `renderCanvas`'s switch in `src/canvases/index.tsx`
3. Register its scenarios in `src/scenarios/registry.ts` (and re-export from
   `src/scenarios/index.ts`)
4. Add a skill in `skills/[name]/SKILL.md`
5. Update the main canvas skill, `README.md` and `commands/canvas.md`
6. Add a render snapshot and a real-socket IPC test

Note that the scenario registry currently has **no runtime consumer**:
`getScenario` is called only from its own test, and `interactionMode` /
`closeOn` / `autoCloseDelay` are read by nothing. Registering a scenario is
bookkeeping today, not behaviour -- `--scenario` is validated for
identifier shape only, never against the registry. See the Phase 2 ledger.

## IPC Protocol

The CLI (`cli.ts`) talks to a running canvas over a length-prefixed JSON
frame protocol on a local TCP socket (`src/runtime/protocol.ts`,
`client.ts`, `server.ts`). Each command speaks a small message set and
prints one JSON result on stdout:

```typescript
// Controller → Canvas
{ type: "hello", token }     // authenticate onto the canvas's socket
{ type: "update", config }   // push new config
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

`ready` is broadcast the instant the server comes up, before any controller
client can possibly have connected yet — it is not currently observable by
external clients (informational only; known and covered by tests).

`wait <id>` polls this connection and surfaces one outcome per call:
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

Host backends (`src/host/`) open the canvas in a new pane: `tmux` or
Windows Terminal, whichever is detected (`detectHost()`).
