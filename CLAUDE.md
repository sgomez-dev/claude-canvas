---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---

<!--
Moved here from canvas/CLAUDE.md on 2026-09-09. `claude plugin validate
--strict` flags a CLAUDE.md at a plugin root, correctly: it is not loaded as
project context from there, so inside the distributable plugin directory it
was dead weight. This content is development documentation for THIS
repository, so the repository root is where it belongs and where Claude Code
actually loads it.
-->

# Canvas Plugin Development

**Paths in this section are relative to `canvas/`**, which is where this
documentation lived until it moved to the repository root. So `src/cli.ts`
means `canvas/src/cli.ts`, and `skills/<name>/SKILL.md` means
`canvas/skills/<name>/SKILL.md`.

Commands, though, run from the **repository root** -- that is where
`bunfig.toml` lives, and the `[test].preload` that pins `TZ` and
`FORCE_COLOR` is only discovered from there:

- `bun test` - Run tests
- `bun x tsc --noEmit` - Typecheck
- `bun run build` - Rebuild the shipped bundle (`canvas/dist/cli.js`)
- `bun run build:check` - Fail if that bundle is stale
- `bun run check:standalone` - Prove the bundle runs with no node_modules
- `bun run canvas/src/cli.ts` - Run the CLI from source
- `bash canvas/scripts/smoke.sh` - Drive every canvas kind through a real
  tmux pane (must be run from inside tmux)

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
`Home`/`End` (region-switching) as well as `Escape`, and tags its outcome
with the `regionId` that produced it. Region-switching is Home/End rather
than Tab/Shift+Tab specifically because `form` binds Tab itself for its own
field navigation, and Ink calls every active `useInput` handler for the
same keystroke instead of routing it to one -- so the shell owning Tab too
would fire both at once. Adding a region kind means adding a case to
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

## Verifying a fix

A fix that reads correctly is not the same as a fix that works. This
project has repeatedly shipped fixes that were structurally right and
incompletely applied — a ref-mirror pattern added to three call sites
out of eleven, a windowing fix that closed one overflow path but left
an identical sibling path open, a bug fixed for the exact numeric case
a test used and not for a neighboring one. Every one of these passed a
first read. None of them survived someone actually reproducing the
failure.

**Before calling anything fixed:**
1. Reproduce the bug on the unfixed code first, with a concrete
   input/action and the exact wrong output it produces. If you can't
   make it fail on demand, you don't understand it well enough to fix
   it.
2. Apply the fix.
3. Reproduce the same scenario again and confirm the correct output —
   not "looks right," the actual before/after evidence.
4. Try at least one variant harder than what you just proved: a
   different ratio/size/count than the first case, a rapid/zero-delay
   sequence instead of a slow one, the sibling code path that shares
   the same bug's shape. A fix that only survives the exact case that
   found it is not yet a fix.

**Reviewing someone else's fix (including a prior session's):** don't
accept "it looks correct," "this is probably just timing/flakiness,"
or "this doesn't need to be tested, it's obviously fine" as a
substitute for reproducing it yourself. Every one of these
characterizations has turned out to be wrong in this project when
someone actually checked — including "0 flakes under load" claims that
were false under load, and "this residual is structurally unfixable"
claims that were true only after someone tried hard to disprove them
first. An identical failure across every platform/environment is
evidence of a real bug, not evidence of flakiness — flaky failures
vary, deterministic bugs don't.

A fix wave that gets independently re-reviewed with real reproduction,
not just a diff read, reliably finds something the original pass
missed — this has held true across every area of this codebase
reviewed this way so far. Budget for it.
