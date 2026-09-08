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

1. Create component in `src/canvases/`
2. Register scenarios in `src/scenarios/`
3. Add skill in `skills/[name]/SKILL.md`
4. Update main canvas skill

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
