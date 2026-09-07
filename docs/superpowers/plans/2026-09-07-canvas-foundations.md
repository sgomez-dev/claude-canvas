# Canvas Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split-brain, Unix-only IPC with one cross-platform transport so that all three canvases can actually return a user selection to Claude, on Windows and Unix, under CI.

**Architecture:** The canvas is the server. It listens on `127.0.0.1:0`, publishes `{port, token, pid}` to a per-canvas registry file, and speaks length-prefixed JSON frames. The controller is a series of short-lived CLI invocations that look the canvas up by id. Panes are opened through a `CanvasHost` interface with `tmux` and Windows Terminal backends, and closed by asking the canvas to exit 0 — never by killing it.

**Tech Stack:** Bun 1.4.2, TypeScript (strict, `noUncheckedIndexedAccess`), React 19, Ink 6, `bun test` with snapshots, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-07-canvas-foundations-design.md` — read it before starting. This plan argues from it; where they disagree, the spec wins.

## Global Constraints

- **Bun is the only runtime.** No Node APIs where a Bun API exists. `bun test`, `bun install`, `bun run`. Bun is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe` on the dev machine if not on PATH.
- **Every canvas process exits 0**, error paths included. A non-zero exit leaves an unremovable pane on Windows. Failures are reported via the registry `lastError` field and an IPC `error` message, never via exit code.
- **Controller CLI invocations use normal exit codes:** 0 for `selected`/`cancelled`/`pending`, 1 for `disconnected`/`error`.
- **Every CLI command prints exactly one JSON object on stdout.** Human-readable diagnostics go to stderr only.
- **`id`, `kind` and `scenario` must match `^[A-Za-z0-9_-]{1,64}$`**, validated before any argv is built. `;` is the critical case: `wt.exe` re-parses its own command line and splits on `;` even inside a correctly quoted argv element.
- **Never build a shell string for a host command.** argv arrays only.
- **Never `console.log` or `console.error` from canvas-side code.** It writes over the Ink render. Use the log file under the data directory.
- **Frame ceiling is 16 MB.** Reject larger and close the connection.
- **No new runtime dependencies.** One dev-only test harness is written in-repo rather than installed.
- **`FORCE_COLOR=1` is pinned for tests**, never `0`.
- **`TZ=UTC` is pinned for tests.** `setSystemTime` fixes the instant but not
  the timezone it renders in, and all three canvases format local time. Without
  this pin every snapshot diverges as soon as the process timezone is not UTC.
- **Target platforms: `win32`, `darwin`, `linux`.** CI runs `ubuntu-latest` and `windows-latest`.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `bunfig.toml` | Test preload registration |
| `canvas/test/setup.ts` | Pins `FORCE_COLOR`, exposes clock helper |
| `canvas/test/harness/render.tsx` | Fake stdout/stdin, frame capture |
| `canvas/src/runtime/paths.ts` | Cross-platform data directory resolution |
| `canvas/src/runtime/validate.ts` | Identifier whitelist — the injection gate |
| `canvas/src/runtime/token.ts` | Random token generation — leaf, so the transport need not import storage |
| `canvas/src/runtime/protocol.ts` | Frame encode/decode, message types |
| `canvas/src/runtime/registry.ts` | Per-canvas record files, liveness, reuse |
| `canvas/src/runtime/server.ts` | Canvas-side TCP server + handshake |
| `canvas/src/runtime/client.ts` | Controller-side client, `wait`, `get` |
| `canvas/src/runtime/use-canvas-server.ts` | The single React hook |
| `canvas/src/host/types.ts` | `CanvasHost` interface, `PaneSpec`, `TerminalCapabilities`, `baseCapabilities` — leaf module, imports nothing from `host/` |
| `canvas/src/host/index.ts` | Detection and the backend list only |
| `canvas/src/host/tmux.ts` | tmux backend |
| `canvas/src/host/windows-terminal.ts` | `wt.exe` backend |
| `.github/workflows/ci.yml` | Matrix CI |

**Deleted (Task 13):** `canvas/src/api/`, `canvas/src/ipc/`, `canvas/src/canvases/calendar/hooks/use-ipc.ts`, `canvas/src/canvases/calendar/hooks/use-ipc-server.ts`, `canvas/src/terminal.ts`, `canvas/run-canvas.sh`.

**Modified:** `canvas/src/cli.ts` (rewritten), the three canvases, `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`, all four `canvas/skills/*/SKILL.md`, `canvas/CLAUDE.md`.

---

### Task 1: Render harness and baseline snapshots

Must be first. These snapshots are the only record of how the canvases render **before** we touch them, and they are the safety net for the ~98 type-error edits in Tasks 15-16.

**Files:**
- Create: `bunfig.toml`, `canvas/test/setup.ts`, `canvas/test/harness/render.tsx`
- Create: `canvas/test/snapshots/document.test.tsx`, `canvas/test/snapshots/calendar.test.tsx`, `canvas/test/snapshots/flight.test.tsx`
- Create: `canvas/test/fixtures/configs.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderCanvas(node, opts?) => { frame(), settle(), frames, dispose() }` from `canvas/test/harness/render.tsx`, where `opts` is `{ columns?: number; rows?: number }`. `FIXED_CLOCK: Date` and the fixture configs from `canvas/test/fixtures/configs.ts`.

- [ ] **Step 1: Create the test preload**

`bunfig.toml` at the repo root:

```toml
[test]
preload = ["./canvas/test/setup.ts"]
```

`canvas/test/setup.ts`:

```ts
// Colour output is all-or-nothing and environment-dependent: the same frame
// measured 752 chars without colour and 1057 with. NO_COLOR does NOT override
// FORCE_COLOR, so pin it explicitly. Pin to "1", not "0" — a render refactor
// can change a colour, and stripping ANSI would hide exactly that regression.
process.env.FORCE_COLOR = "1";
```

- [ ] **Step 2: Write the harness**

`canvas/test/harness/render.tsx`:

```tsx
import { render as inkRender, type Instance } from "ink";
import { EventEmitter } from "node:events";
import type { ReactElement } from "react";

// Must extend EventEmitter. A plain object fails with:
// "options.stdout.on is not a function"
class TestStdout extends EventEmitter {
  frames: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }
  write = (data: string): boolean => {
    this.frames.push(data);
    return true;
  };
}

// Mandatory for any canvas using useInput. Without it, Ink renders its own
// error screen ("Raw mode is not supported on the current process.stdin") as a
// 3443-character frame with a React stack trace, and NOTHING THROWS — the test
// passes while snapshotting a stack trace.
class TestStdin extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  write = (d: string): void => {
    this.pending = d;
    this.emit("readable");
    this.emit("data", d);
  };
  read = (): string | null => {
    const d = this.pending;
    this.pending = null;
    return d;
  };
}

export interface RenderResult {
  frames: string[];
  frame(): string;
  settle(): Promise<string>;
  dispose(): void;
}

export function renderCanvas(
  node: ReactElement,
  opts: { columns?: number; rows?: number } = {}
): RenderResult {
  // A fresh stdout per render: Ink keys instances by the stdout object, so
  // reusing one rerenders the first tree instead of mounting a new root.
  const stdout = new TestStdout(opts.columns ?? 80, opts.rows ?? 24);
  const stdin = new TestStdin();
  const instance: Instance = inkRender(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true, // Mandatory. Without it Ink routes through log-update and
                 // coalesces frames with cursor escapes.
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    frames: stdout.frames,
    frame: () => stdout.frames.at(-1) ?? "",
    // State set in a mount effect is absent from the synchronous frame AND
    // after a microtask. Only a macrotask surfaces it.
    async settle() {
      await new Promise((r) => setTimeout(r, 0));
      return stdout.frames.at(-1) ?? "";
    },
    dispose() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

// use-mouse.ts writes mouse-tracking escapes to the REAL process.stdout,
// bypassing the injected stream. Left unstubbed it spams the developer's
// terminal and, on a crash, strands it in SGR mouse mode.
export function stubRealStdout(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}
```

- [ ] **Step 3: Write the fixtures**

`canvas/test/fixtures/configs.ts`:

```ts
import type { DocumentConfig } from "../../src/canvases/document/types";

// Two of the three canvases render live clocks, so every fixture pins the
// clock. cyberpunk-header.tsx:28 renders new Date().toLocaleTimeString() and
// calendar.tsx:367 keeps a currentTime on a setInterval.
export const FIXED_CLOCK = new Date("2026-03-15T09:30:00.000Z");

export const documentConfig: DocumentConfig = {
  title: "Quarterly Review",
  content: "# Heading\n\nSome **bold** text.\n\n- one\n- two\n",
};

export const calendarDisplayConfig = {
  title: "Team Calendar",
  events: [
    {
      id: "e1",
      title: "Standup",
      startTime: "2026-03-15T09:00:00.000Z",
      endTime: "2026-03-15T09:15:00.000Z",
    },
  ],
  startHour: 8,
  endHour: 18,
};

export const meetingPickerConfig = {
  calendars: [
    {
      name: "Ana",
      color: "cyan",
      events: [
        {
          id: "b1",
          title: "Busy",
          startTime: "2026-03-15T10:00:00.000Z",
          endTime: "2026-03-15T11:00:00.000Z",
        },
      ],
    },
  ],
  slotGranularity: 30 as const,
  minDuration: 30,
  maxDuration: 60,
};

export const flightConfig = {
  title: "// FLIGHT_BOOKING_TERMINAL //",
  flights: [
    {
      id: "ua123",
      airline: "United Airlines",
      flightNumber: "UA 123",
      origin: { code: "SFO", city: "San Francisco" },
      destination: { code: "DEN", city: "Denver" },
      departureTime: "2026-03-15T08:00:00.000Z",
      arrivalTime: "2026-03-15T11:30:00.000Z",
      price: 289,
    },
  ],
};
```

If a fixture field name does not match the real type, read the corresponding `types.ts` and correct the fixture — do not loosen the type.

- [ ] **Step 4: Write the document snapshot test**

`canvas/test/snapshots/document.test.tsx`:

```tsx
import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { Document } from "../../src/canvases/document";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { documentConfig, FIXED_CLOCK } from "../fixtures/configs";

let restore: () => void;

beforeEach(() => {
  setSystemTime(FIXED_CLOCK);
  restore = stubRealStdout();
});

afterEach(() => {
  restore();
  setSystemTime();
});

test("document display renders", async () => {
  const r = renderCanvas(
    <Document id="doc-1" config={documentConfig} socketPath={undefined} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("document display is deterministic across renders", async () => {
  const first = renderCanvas(
    <Document id="doc-1" config={documentConfig} socketPath={undefined} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const a = await first.settle();
  first.dispose();

  const second = renderCanvas(
    <Document id="doc-1" config={documentConfig} socketPath={undefined} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const b = await second.settle();
  second.dispose();

  expect(b).toBe(a);
});
```

`socketPath={undefined}` is what keeps the canvas offline — both current hooks early-return on a falsy socket path (`use-ipc-server.ts:44`, `use-ipc.ts:37`).

- [ ] **Step 5: Run and confirm snapshots are written**

Run: `bun test canvas/test/snapshots/document.test.tsx`
Expected: PASS, and `canvas/test/snapshots/__snapshots__/document.test.tsx.snap` now exists containing a readable frame.

- [ ] **Step 6: Run again to confirm the snapshot compares rather than rewrites**

Run: `bun test canvas/test/snapshots/document.test.tsx`
Expected: PASS with no snapshot written. If it rewrites every run, the frame is non-deterministic — stop and find the unpinned source before continuing.

- [ ] **Step 7: Repeat Steps 4-6 for calendar and flight**

`calendar.test.tsx` covers two scenarios — `display` with `calendarDisplayConfig`, and `meeting-picker` with `config={{...calendarDisplayConfig, ...meetingPickerConfig}}` and `scenario="meeting-picker"`. `flight.test.tsx` renders `FlightCanvas` with `flightConfig` and `scenario="booking"`. Each gets the same three tests: snapshot, determinism, and the same `beforeEach`/`afterEach` clock pinning.

Expect a React duplicate-key warning on stderr from `document.tsx` — a known defect fixed in Task 14, not a failure here.

- [ ] **Step 8: Commit**

```bash
git add bunfig.toml canvas/test
git commit -m "test: add render harness and baseline canvas snapshots"
```

---

### Task 2: Cross-platform paths

**Files:**
- Create: `canvas/src/runtime/paths.ts`, `canvas/src/runtime/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `dataDir(): string`, `canvasesDir(): string`, `recordPath(id: string): string`, `configPath(id: string): string`, `logPath(id: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { dataDir, recordPath, configPath } from "./paths";
import { homedir } from "node:os";

test("dataDir is absolute and contains the app name", () => {
  const d = dataDir();
  expect(d).toContain("claude-canvas");
  expect(d.length).toBeGreaterThan(homedir().length);
});

test("dataDir contains no /tmp", () => {
  expect(dataDir()).not.toContain("/tmp");
});

test("recordPath is under canvasesDir and ends in .json", () => {
  expect(recordPath("abc")).toEndWith("abc.json");
});

test("configPath and recordPath never collide", () => {
  expect(configPath("abc")).not.toBe(recordPath("abc"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/paths.test.ts`
Expected: FAIL — cannot resolve module `./paths`.

- [ ] **Step 3: Implement**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "claude-canvas";

export function dataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, APP);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP);
  }
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, APP);
}

export function canvasesDir(): string {
  return join(dataDir(), "canvases");
}

export function recordPath(id: string): string {
  return join(canvasesDir(), `${id}.json`);
}

export function configPath(id: string): string {
  return join(dataDir(), "configs", `${id}.json`);
}

export function logPath(id: string): string {
  return join(dataDir(), "logs", `${id}.log`);
}
```

Callers pass only validated ids (Task 3), so no path traversal is possible here.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/paths.ts canvas/src/runtime/paths.test.ts
git commit -m "feat: cross-platform data directory resolution"
```

---

### Task 3: Identifier validation — the injection gate

This is the security-critical task. argv arrays alone do **not** close the hole: `wt.exe` re-parses its raw command line and splits on `;` even inside one correctly quoted argv element. A single `-Command` argument with three semicolons was shredded into four separate `wt` commands, each opening its own tab. This whitelist is what actually protects the Windows backend.

**Files:**
- Create: `canvas/src/runtime/validate.ts`, `canvas/src/runtime/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IDENT_RE: RegExp`, `assertIdent(field: string, value: string): string` (returns the value, throws `InvalidIdentifierError`), `class InvalidIdentifierError extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, describe } from "bun:test";
import { assertIdent, InvalidIdentifierError } from "./validate";

describe("accepts legitimate identifiers", () => {
  for (const ok of ["calendar", "doc-1", "meeting_picker", "a", "A9-_", "x".repeat(64)]) {
    test(ok, () => expect(assertIdent("id", ok)).toBe(ok));
  }
});

describe("rejects injection payloads", () => {
  const bad = [
    "x; rm -rf /",        // the wt command-grammar split
    "x;calc",
    "a b",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    'a"b',
    "a'b",
    "a`b",
    "a$b",
    "a|b",
    "a&b",
    "a\nb",
    "",
    "x".repeat(65),
  ];
  for (const value of bad) {
    test(JSON.stringify(value), () => {
      expect(() => assertIdent("id", value)).toThrow(InvalidIdentifierError);
    });
  }
});

test("the error names the offending field and does not echo the payload", () => {
  try {
    assertIdent("scenario", "x; calc");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidIdentifierError);
    expect((e as Error).message).toContain("scenario");
    expect((e as Error).message).not.toContain("calc");
  }
});
```

Not echoing the payload matters: the message may reach a terminal or a log, and echoing attacker-controlled text into either is how escape-sequence tricks land.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/validate.test.ts`
Expected: FAIL — cannot resolve module `./validate`.

- [ ] **Step 3: Implement**

```ts
export const IDENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidIdentifierError extends Error {
  constructor(field: string) {
    super(
      `Invalid ${field}: must match ${IDENT_RE.source}. ` +
        `Letters, digits, underscore and hyphen only, 1-64 characters.`
    );
    this.name = "InvalidIdentifierError";
  }
}

export function assertIdent(field: string, value: string): string {
  if (!IDENT_RE.test(value)) throw new InvalidIdentifierError(field);
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/validate.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/validate.ts canvas/src/runtime/validate.test.ts
git commit -m "feat: identifier whitelist to close host argv injection"
```

---

### Task 4: Protocol framing

**Files:**
- Create: `canvas/src/runtime/protocol.ts`, `canvas/src/runtime/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_FRAME_BYTES: number`, `encodeFrame(msg: unknown): Uint8Array`, `class FrameDecoder { push(chunk: Uint8Array): unknown[] }`, `class FrameTooLargeError extends Error`, and the types `ControllerMessage` and `CanvasMessage`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { encodeFrame, FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from "./protocol";

test("roundtrips one frame", () => {
  const d = new FrameDecoder();
  expect(d.push(encodeFrame({ type: "ping" }))).toEqual([{ type: "ping" }]);
});

test("reassembles a frame split across three chunks", () => {
  const buf = encodeFrame({ type: "selected", data: { a: 1 } });
  const d = new FrameDecoder();
  expect(d.push(buf.slice(0, 2))).toEqual([]);
  expect(d.push(buf.slice(2, 7))).toEqual([]);
  expect(d.push(buf.slice(7))).toEqual([{ type: "selected", data: { a: 1 } }]);
});

test("returns several frames arriving in one chunk", () => {
  const a = encodeFrame({ type: "ping" });
  const b = encodeFrame({ type: "pong" });
  const both = new Uint8Array(a.length + b.length);
  both.set(a, 0);
  both.set(b, a.length);
  expect(new FrameDecoder().push(both)).toEqual([{ type: "ping" }, { type: "pong" }]);
});

test("survives a payload containing newlines", () => {
  // The old newline-delimited protocol broke on exactly this.
  const msg = { type: "update", config: { content: "line1\nline2\n" } };
  expect(new FrameDecoder().push(encodeFrame(msg))).toEqual([msg]);
});

test("rejects a frame declaring more than the ceiling", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
  expect(() => new FrameDecoder().push(header)).toThrow(FrameTooLargeError);
});

test("refuses to encode an oversized payload", () => {
  expect(() => encodeFrame({ type: "update", config: "x".repeat(MAX_FRAME_BYTES) }))
    .toThrow(FrameTooLargeError);
});

test("throws on malformed JSON inside a well-formed frame", () => {
  const body = new TextEncoder().encode("{not json");
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  expect(() => new FrameDecoder().push(frame)).toThrow();
});

test("handles a zero-length chunk", () => {
  expect(new FrameDecoder().push(new Uint8Array(0))).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/protocol.test.ts`
Expected: FAIL — cannot resolve module `./protocol`.

- [ ] **Step 3: Implement**

```ts
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  constructor(size: number) {
    super(`Frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte ceiling`);
    this.name = "FrameTooLargeError";
  }
}

export function encodeFrame(msg: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  if (body.byteLength > MAX_FRAME_BYTES) throw new FrameTooLargeError(body.byteLength);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, false);
  out.set(body, 4);
  return out;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.byteLength);
      this.buf = merged;
    }

    const out: unknown[] = [];
    for (;;) {
      if (this.buf.byteLength < 4) break;
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength
      ).getUint32(0, false);
      // Checked before allocating, so a hostile length prefix cannot make us
      // reserve unbounded memory.
      if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
      if (this.buf.byteLength < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      out.push(JSON.parse(new TextDecoder().decode(body)));
      this.buf = this.buf.slice(4 + len);
    }
    return out;
  }
}

export type ControllerMessage =
  | { type: "hello"; token: string }
  | { type: "update"; config: unknown }
  | { type: "get"; key: string }
  | { type: "close" }
  | { type: "ping" };

export type CanvasMessage =
  | { type: "hello-ok" }
  | { type: "error"; message: string }
  | { type: "ready"; scenario: string; capabilities: unknown }
  | { type: "value"; key: string; data: unknown }
  | { type: "selected"; data: unknown }
  | { type: "cancelled"; reason?: string }
  | { type: "pong" };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/protocol.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/protocol.ts canvas/src/runtime/protocol.test.ts
git commit -m "feat: length-prefixed frame protocol with 16MB ceiling"
```

---

### Task 5: Registry

**Files:**
- Create: `canvas/src/runtime/token.ts`, `canvas/src/runtime/registry.ts`, `canvas/src/runtime/registry.test.ts`

`token.ts` is a deliberate leaf module rather than a function inside
`registry.ts`. If `newToken` lived in the registry, `server.ts` would import
the storage layer purely to obtain a random hex string, dragging in `paths.ts`
and `validate.ts` with it — a layering inversion. The token belongs to the
transport's authentication concern.

```ts
// canvas/src/runtime/token.ts
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

**Interfaces:**
- Consumes: `recordPath`, `canvasesDir` (Task 2); `assertIdent` (Task 3); `newToken` from `./token`.
- Produces:

```ts
export interface CanvasRecord {
  id: string; kind: string; scenario: string;
  port: number; token: string; pid: number;
  startedAt: string; host: string;
  wtSession?: string; lastError?: string;
}
export function isAlive(pid: number): boolean
export async function writeRecord(r: CanvasRecord): Promise<void>
export async function readRecord(id: string): Promise<CanvasRecord | null>
export async function listRecords(): Promise<CanvasRecord[]>
export async function deleteRecord(id: string): Promise<void>
export function newToken(): string
```

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, afterEach } from "bun:test";
import { writeRecord, readRecord, listRecords, deleteRecord, newToken, isAlive, type CanvasRecord } from "./registry";

const ids: string[] = [];
function rec(id: string, over: Partial<CanvasRecord> = {}): CanvasRecord {
  ids.push(id);
  return { id, kind: "document", scenario: "display", port: 1234,
    token: newToken(), pid: process.pid, startedAt: new Date().toISOString(),
    host: "tmux", ...over };
}
afterEach(async () => { for (const id of ids.splice(0)) await deleteRecord(id); });

test("roundtrips a record", async () => {
  const r = rec("t-round");
  await writeRecord(r);
  expect(await readRecord("t-round")).toEqual(r);
});

test("returns null for an unknown id", async () => {
  expect(await readRecord("t-missing")).toBeNull();
});

test("unlinks and returns null when the pid is dead", async () => {
  // pid 0x7FFFFFFE will not exist on any platform in practice.
  await writeRecord(rec("t-dead", { pid: 0x7ffffffe }));
  expect(await readRecord("t-dead")).toBeNull();
  expect(await Bun.file((await import("./paths")).recordPath("t-dead")).exists()).toBe(false);
});

test("two concurrent canvases do not collide", async () => {
  await Promise.all([writeRecord(rec("t-a", { port: 1 })), writeRecord(rec("t-b", { port: 2 }))]);
  expect((await readRecord("t-a"))?.port).toBe(1);
  expect((await readRecord("t-b"))?.port).toBe(2);
});

test("listRecords omits dead canvases", async () => {
  await writeRecord(rec("t-live"));
  await writeRecord(rec("t-zombie", { pid: 0x7ffffffe }));
  const listed = (await listRecords()).map((r) => r.id);
  expect(listed).toContain("t-live");
  expect(listed).not.toContain("t-zombie");
});

test("a lastError record survives even with no port", async () => {
  await writeRecord(rec("t-err", { lastError: "bind failed" }));
  expect((await readRecord("t-err"))?.lastError).toBe("bind failed");
});

test("tokens are unique and long enough", () => {
  const a = newToken();
  expect(a).toHaveLength(64);
  expect(a).not.toBe(newToken());
});

test("isAlive is true for this process", () => {
  expect(isAlive(process.pid)).toBe(true);
});

test("rejects an invalid id", async () => {
  await expect(readRecord("../escape")).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/registry.test.ts`
Expected: FAIL — cannot resolve module `./registry`.

- [ ] **Step 3: Implement**

```ts
import { mkdir, unlink, chmod, readdir } from "node:fs/promises";
import { canvasesDir, recordPath } from "./paths";
import { assertIdent } from "./validate";
export { newToken } from "./token";

export interface CanvasRecord {
  id: string; kind: string; scenario: string;
  port: number; token: string; pid: number;
  startedAt: string; host: string;
  wtSession?: string; lastError?: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeRecord(r: CanvasRecord): Promise<void> {
  assertIdent("id", r.id);
  await mkdir(canvasesDir(), { recursive: true });
  const path = recordPath(r.id);
  await Bun.write(path, JSON.stringify(r, null, 2));
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function readRecord(id: string): Promise<CanvasRecord | null> {
  assertIdent("id", id);
  const file = Bun.file(recordPath(id));
  if (!(await file.exists())) return null;
  let r: CanvasRecord;
  try {
    r = (await file.json()) as CanvasRecord;
  } catch {
    await deleteRecord(id);
    return null;
  }
  // A record with lastError and no live process is still readable, so a
  // failed canvas stays discoverable rather than vanishing silently.
  if (r.lastError) return r;
  if (!isAlive(r.pid)) {
    await deleteRecord(id);
    return null;
  }
  return r;
}

export async function listRecords(): Promise<CanvasRecord[]> {
  let names: string[];
  try {
    names = await readdir(canvasesDir());
  } catch {
    return [];
  }
  const out: CanvasRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const r = await readRecord(name.slice(0, -5));
    if (r && !r.lastError) out.push(r);
  }
  return out;
}

export async function deleteRecord(id: string): Promise<void> {
  assertIdent("id", id);
  try {
    await unlink(recordPath(id));
  } catch {
    // already gone
  }
}
```

The `t-err` test writes a record whose pid is this live process, so it passes on the `lastError` branch; the branch is what keeps a bind failure discoverable.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/registry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/registry.ts canvas/src/runtime/registry.test.ts
git commit -m "feat: per-canvas registry with liveness and token auth material"
```

---

### Task 6: Canvas-side server with handshake

**Files:**
- Create: `canvas/src/runtime/server.ts`, `canvas/src/runtime/server.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`, `FrameDecoder`, `ControllerMessage`, `CanvasMessage` (Task 4); `newToken` from `./token` (Task 5) — never from `./registry`, which would invert the layering.
- Produces:

```ts
export interface CanvasServer {
  port: number; token: string;
  broadcast(msg: CanvasMessage): void;
  stop(): void;
}
export interface CanvasServerOptions {
  token?: string;
  onMessage(msg: ControllerMessage, reply: (m: CanvasMessage) => void): void;
  onError?(e: Error): void;
}
export async function startCanvasServer(o: CanvasServerOptions): Promise<CanvasServer>
```

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { startCanvasServer } from "./server";
import { encodeFrame, FrameDecoder, type CanvasMessage } from "./protocol";

async function talk(port: number, frames: Uint8Array[]): Promise<CanvasMessage[]> {
  const got: CanvasMessage[] = [];
  const dec = new FrameDecoder();
  let closed = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port,
    socket: {
      data(_s, d) { for (const m of dec.push(new Uint8Array(d))) got.push(m as CanvasMessage); },
      close() { closed = true; },
      error() { closed = true; },
    },
  });
  for (const f of frames) socket.write(f);
  await new Promise((r) => setTimeout(r, 60));
  if (!closed) socket.end();
  return got;
}

test("listens on an ephemeral loopback port", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  expect(s.port).toBeGreaterThan(0);
  s.stop();
});

test("accepts the correct token", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  const got = await talk(s.port, [encodeFrame({ type: "hello", token: s.token })]);
  expect(got[0]).toEqual({ type: "hello-ok" });
  s.stop();
});

test("rejects a wrong token and delivers no message", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  const got = await talk(s.port, [
    encodeFrame({ type: "hello", token: "0".repeat(64) }),
    encodeFrame({ type: "get", key: "content" }),
  ]);
  expect(got[0]?.type).toBe("error");
  expect(delivered).toBe(0);
  s.stop();
});

test("rejects a first frame that is not hello", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  const got = await talk(s.port, [encodeFrame({ type: "ping" })]);
  expect(got[0]?.type).toBe("error");
  expect(delivered).toBe(0);
  s.stop();
});

test("routes messages after a successful handshake", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: "hi" });
    },
  });
  const got = await talk(s.port, [
    encodeFrame({ type: "hello", token: s.token }),
    encodeFrame({ type: "get", key: "content" }),
  ]);
  expect(got).toEqual([{ type: "hello-ok" }, { type: "value", key: "content", data: "hi" }]);
  s.stop();
});

test("broadcast reaches an authenticated client", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  const dec = new FrameDecoder();
  const got: CanvasMessage[] = [];
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port: s.port,
    socket: { data(_x, d) { for (const m of dec.push(new Uint8Array(d))) got.push(m as CanvasMessage); } },
  });
  socket.write(encodeFrame({ type: "hello", token: s.token }));
  await new Promise((r) => setTimeout(r, 40));
  s.broadcast({ type: "selected", data: { ok: true } });
  await new Promise((r) => setTimeout(r, 40));
  expect(got).toContainEqual({ type: "selected", data: { ok: true } });
  socket.end();
  s.stop();
});

test("never calls onMessage for an unauthenticated socket even after many frames", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  await talk(s.port, Array.from({ length: 5 }, () => encodeFrame({ type: "ping" })));
  expect(delivered).toBe(0);
  s.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/server.test.ts`
Expected: FAIL — cannot resolve module `./server`.

- [ ] **Step 3: Implement**

```ts
import { encodeFrame, FrameDecoder, type CanvasMessage, type ControllerMessage } from "./protocol";
import { newToken } from "./token";
import type { Socket } from "bun";

export interface CanvasServer {
  port: number;
  token: string;
  broadcast(msg: CanvasMessage): void;
  stop(): void;
}

export interface CanvasServerOptions {
  token?: string;
  onMessage(msg: ControllerMessage, reply: (m: CanvasMessage) => void): void;
  onError?(e: Error): void;
}

interface ConnState {
  authed: boolean;
  decoder: FrameDecoder;
}

export async function startCanvasServer(o: CanvasServerOptions): Promise<CanvasServer> {
  const token = o.token ?? newToken();
  const conns = new Map<Socket<undefined>, ConnState>();

  const send = (socket: Socket<undefined>, msg: CanvasMessage) => {
    try {
      socket.write(encodeFrame(msg));
    } catch (e) {
      o.onError?.(e as Error);
    }
  };

  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        conns.set(socket, { authed: false, decoder: new FrameDecoder() });
      },
      data(socket, data) {
        const state = conns.get(socket);
        if (!state) return;
        let msgs: unknown[];
        try {
          msgs = state.decoder.push(new Uint8Array(data));
        } catch (e) {
          o.onError?.(e as Error);
          send(socket, { type: "error", message: "protocol error" });
          socket.end();
          return;
        }
        for (const raw of msgs) {
          const msg = raw as ControllerMessage;
          if (!state.authed) {
            // The first frame must be a matching hello. Anything else closes
            // the connection: this is what makes loopback TCP acceptable.
            if (msg.type !== "hello" || msg.token !== token) {
              send(socket, { type: "error", message: "authentication failed" });
              socket.end();
              return;
            }
            state.authed = true;
            send(socket, { type: "hello-ok" });
            continue;
          }
          o.onMessage(msg, (reply) => send(socket, reply));
        }
      },
      close(socket) {
        conns.delete(socket);
      },
      error(socket, error) {
        o.onError?.(error);
        conns.delete(socket);
      },
    },
  });

  return {
    port: server.port,
    token,
    broadcast(msg) {
      for (const [socket, state] of conns) if (state.authed) send(socket, msg);
    },
    stop() {
      for (const socket of conns.keys()) socket.end();
      conns.clear();
      server.stop();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/server.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/server.ts canvas/src/runtime/server.test.ts
git commit -m "feat: canvas TCP server with mandatory token handshake"
```

---

### Task 7: Controller client and the end-to-end integration test

This task produces the test that proves the original defect is dead: a full round trip with no tmux, no Windows Terminal, and no terminal at all.

**Files:**
- Create: `canvas/src/runtime/client.ts`, `canvas/src/runtime/client.test.ts`
- Create: `canvas/src/runtime/integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-6.
- Produces:

```ts
export type WaitResult =
  | { status: "selected"; data: unknown }
  | { status: "cancelled"; reason?: string }
  | { status: "pending" }
  | { status: "disconnected" }
  | { status: "error"; message: string };

export const DEFAULT_WAIT_MS = 55_000;

export async function openConnection(id: string): Promise<Connection>
export interface Connection {
  send(msg: ControllerMessage): void;
  next(timeoutMs: number): Promise<CanvasMessage | null>;
  close(): void;
}
export async function getValue(id: string, key: string): Promise<unknown>
export async function requestClose(id: string): Promise<void>
export async function waitForOutcome(id: string, timeoutMs?: number): Promise<WaitResult>
```

- [ ] **Step 1: Write the failing client test**

```ts
import { test, expect, afterEach } from "bun:test";
import { startCanvasServer } from "./server";
import { writeRecord, deleteRecord, newToken } from "./registry";
import { getValue, waitForOutcome, requestClose } from "./client";

const ids: string[] = [];
afterEach(async () => { for (const id of ids.splice(0)) await deleteRecord(id); });

async function publish(id: string, s: { port: number; token: string }) {
  ids.push(id);
  await writeRecord({ id, kind: "document", scenario: "display", port: s.port,
    token: s.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });
}

test("getValue performs the handshake and returns the value", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: { text: "hello" } });
    },
  });
  await publish("c-get", s);
  expect(await getValue("c-get", "content")).toEqual({ text: "hello" });
  s.stop();
});

test("waitForOutcome resolves selected", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  await publish("c-sel", s);
  setTimeout(() => s.broadcast({ type: "selected", data: { slot: 3 } }), 30);
  expect(await waitForOutcome("c-sel", 2000)).toEqual({ status: "selected", data: { slot: 3 } });
  s.stop();
});

test("waitForOutcome resolves cancelled", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  await publish("c-can", s);
  setTimeout(() => s.broadcast({ type: "cancelled", reason: "escape" }), 30);
  expect(await waitForOutcome("c-can", 2000)).toEqual({ status: "cancelled", reason: "escape" });
  s.stop();
});

test("waitForOutcome returns pending on timeout while the canvas is alive", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  await publish("c-pend", s);
  expect(await waitForOutcome("c-pend", 150)).toEqual({ status: "pending" });
  s.stop();
});

test("waitForOutcome returns disconnected when the canvas goes away", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  await publish("c-gone", s);
  setTimeout(() => s.stop(), 40);
  expect((await waitForOutcome("c-gone", 3000)).status).toBe("disconnected");
});

test("errors when the canvas id is unknown", async () => {
  expect((await waitForOutcome("c-nobody", 200)).status).toBe("error");
});

test("errors when the registry token is wrong", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  await publish("c-badtok", { port: s.port, token: newToken() });
  expect((await waitForOutcome("c-badtok", 1000)).status).toBe("error");
  s.stop();
});

test("requestClose sends the close message", async () => {
  let closed = false;
  const s = await startCanvasServer({ onMessage(msg) { if (msg.type === "close") closed = true; } });
  await publish("c-close", s);
  await requestClose("c-close");
  await new Promise((r) => setTimeout(r, 60));
  expect(closed).toBe(true);
  s.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/client.test.ts`
Expected: FAIL — cannot resolve module `./client`.

- [ ] **Step 3: Implement the client**

```ts
import { encodeFrame, FrameDecoder, type CanvasMessage, type ControllerMessage } from "./protocol";
import { readRecord } from "./registry";

export const DEFAULT_WAIT_MS = 55_000;

export type WaitResult =
  | { status: "selected"; data: unknown }
  | { status: "cancelled"; reason?: string }
  | { status: "pending" }
  | { status: "disconnected" }
  | { status: "error"; message: string };

export interface Connection {
  send(msg: ControllerMessage): void;
  next(timeoutMs: number): Promise<CanvasMessage | null>;
  close(): void;
}

class NoSuchCanvasError extends Error {}

export async function openConnection(id: string): Promise<Connection> {
  const record = await readRecord(id);
  if (!record) throw new NoSuchCanvasError(`no canvas ${id}`);
  if (record.lastError) throw new Error(record.lastError);

  const inbox: CanvasMessage[] = [];
  const waiters: ((m: CanvasMessage | null) => void)[] = [];
  let dead = false;
  const decoder = new FrameDecoder();

  const settle = (m: CanvasMessage | null) => {
    const w = waiters.shift();
    if (w) w(m);
    else if (m) inbox.push(m);
  };
  const die = () => {
    dead = true;
    while (waiters.length) waiters.shift()?.(null);
  };

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(_s, data) {
        for (const raw of decoder.push(new Uint8Array(data))) settle(raw as CanvasMessage);
      },
      close: die,
      error: die,
    },
  });

  const conn: Connection = {
    send(msg) {
      if (!dead) socket.write(encodeFrame(msg));
    },
    next(timeoutMs) {
      const buffered = inbox.shift();
      if (buffered) return Promise.resolve(buffered);
      if (dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(handler);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const handler = (m: CanvasMessage | null) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(handler);
      });
    },
    close() {
      socket.end();
    },
  };

  conn.send({ type: "hello", token: record.token });
  const ack = await conn.next(3000);
  if (!ack || ack.type !== "hello-ok") {
    conn.close();
    throw new Error(ack?.type === "error" ? ack.message : "handshake failed");
  }
  return conn;
}

export async function getValue(id: string, key: string): Promise<unknown> {
  const conn = await openConnection(id);
  try {
    conn.send({ type: "get", key });
    for (;;) {
      const msg = await conn.next(3000);
      if (!msg) throw new Error("no response");
      if (msg.type === "value" && msg.key === key) return msg.data;
      if (msg.type === "error") throw new Error(msg.message);
    }
  } finally {
    conn.close();
  }
}

export async function requestClose(id: string): Promise<void> {
  const conn = await openConnection(id);
  // Closing is always a request. Never kill the process: on Windows a
  // non-zero exit leaves a pane that no command can remove.
  conn.send({ type: "close" });
  conn.close();
}

export async function waitForOutcome(
  id: string,
  timeoutMs: number = DEFAULT_WAIT_MS
): Promise<WaitResult> {
  let conn: Connection;
  try {
    conn = await openConnection(id);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "pending" };
      const msg = await conn.next(remaining);
      if (msg === null) {
        return Date.now() >= deadline ? { status: "pending" } : { status: "disconnected" };
      }
      if (msg.type === "selected") return { status: "selected", data: msg.data };
      if (msg.type === "cancelled") return { status: "cancelled", reason: msg.reason };
      if (msg.type === "error") return { status: "error", message: msg.message };
      // ready / value / pong / hello-ok are not outcomes; keep waiting.
    }
  } finally {
    conn.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the integration test**

`canvas/src/runtime/integration.test.ts`:

```ts
import { test, expect, afterEach } from "bun:test";
import { startCanvasServer } from "./server";
import { writeRecord, deleteRecord } from "./registry";
import { openConnection, waitForOutcome, getValue } from "./client";
import type { ControllerMessage } from "./protocol";

const ids: string[] = [];
afterEach(async () => { for (const id of ids.splice(0)) await deleteRecord(id); });

// The regression test for the original defect: user selections never reached
// the controller in two of three canvases. Runs with no tmux, no Windows
// Terminal, and no terminal at all — which is what makes CI possible.
test("full round trip: ready, update, get, selected, close", async () => {
  const seen: ControllerMessage[] = [];
  let config: unknown = { content: "v1" };
  let closed = false;

  const server = await startCanvasServer({
    onMessage(msg, reply) {
      seen.push(msg);
      if (msg.type === "update") config = msg.config;
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: config });
      if (msg.type === "close") closed = true;
    },
  });

  const id = "it-round";
  ids.push(id);
  await writeRecord({ id, kind: "document", scenario: "edit", port: server.port,
    token: server.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });

  const conn = await openConnection(id);
  server.broadcast({ type: "ready", scenario: "edit", capabilities: { graphics: "none" } });
  expect((await conn.next(1000))?.type).toBe("ready");

  conn.send({ type: "update", config: { content: "v2" } });
  await new Promise((r) => setTimeout(r, 40));
  expect(await getValue(id, "content")).toEqual({ content: "v2" });

  const outcome = waitForOutcome(id, 3000);
  setTimeout(() => server.broadcast({ type: "selected", data: { offset: 7 } }), 40);
  expect(await outcome).toEqual({ status: "selected", data: { offset: 7 } });

  conn.send({ type: "close" });
  await new Promise((r) => setTimeout(r, 40));
  expect(closed).toBe(true);

  conn.close();
  server.stop();
});

test("a payload larger than the old newline protocol could carry survives", async () => {
  // Phase 3 will send screenshots. 4 MB of base64-ish text with newlines.
  const big = "QUJD\n".repeat(800_000);
  let received = "";
  const server = await startCanvasServer({
    onMessage(msg) { if (msg.type === "update") received = (msg.config as { blob: string }).blob; },
  });
  const id = "it-big";
  ids.push(id);
  await writeRecord({ id, kind: "document", scenario: "display", port: server.port,
    token: server.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });

  const conn = await openConnection(id);
  conn.send({ type: "update", config: { blob: big } });
  await new Promise((r) => setTimeout(r, 400));
  expect(received.length).toBe(big.length);
  conn.close();
  server.stop();
});
```

- [ ] **Step 6: Run the integration test**

Run: `bun test canvas/src/runtime/integration.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add canvas/src/runtime/client.ts canvas/src/runtime/client.test.ts canvas/src/runtime/integration.test.ts
git commit -m "feat: controller client with wait/get/close and end-to-end test"
```

---

### Task 8: CanvasHost interface, detection, and capabilities

**Files:**
- Create: `canvas/src/host/types.ts`, `canvas/src/host/index.ts`, `canvas/src/host/index.test.ts`

**Split into two modules to avoid a circular runtime import.** `index.ts` must
import the backends, and the backends need `baseCapabilities` — if that value
lives in `index.ts`, the cycle can leave it `undefined` at module
initialisation depending on evaluation order. So `types.ts` is a leaf that
imports nothing from `host/`, and everything else imports from it.

**Interfaces:**
- Consumes: nothing.
- Produces from `host/types.ts`:

```ts
export interface TerminalCapabilities {
  graphics: "kitty" | "iterm2" | "sixel" | "none";
  trueColor: boolean; mouse: boolean; columns: number; rows: number;
}
export interface PaneSpec { argv: string[]; title: string; ratio: number }
export interface PaneHandle { host: string; wtSession?: string }
export interface CanvasHost {
  name: string;
  isAvailable(env: NodeJS.ProcessEnv): boolean;
  capabilities(env: NodeJS.ProcessEnv): TerminalCapabilities;
  buildArgv(spec: PaneSpec): string[];
  open(spec: PaneSpec): Promise<PaneHandle>;
}
export function baseCapabilities(env: NodeJS.ProcessEnv): TerminalCapabilities
```

- Produces from `host/index.ts`:

```ts
export function detectHost(env?: NodeJS.ProcessEnv): CanvasHost
export class NoHostError extends Error {}
export * from "./types"   // so callers have one import site
```

`isAvailable` and `capabilities` take `env` explicitly so tests need not mutate `process.env`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { detectHost, NoHostError } from "./index";

test("picks tmux when TMUX is set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0" }).name).toBe("tmux");
});

test("picks wt when WT_SESSION is set", () => {
  expect(detectHost({ WT_SESSION: "abc" }).name).toBe("windows-terminal");
});

test("prefers tmux when both are set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0", WT_SESSION: "abc" }).name).toBe("tmux");
});

test("throws a message naming what was tried when no host is available", () => {
  try {
    detectHost({});
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(NoHostError);
    expect((e as Error).message).toContain("tmux");
    expect((e as Error).message).toContain("Windows Terminal");
  }
});

test("graphics is always none in phase 1", () => {
  expect(detectHost({ TMUX: "x" }).capabilities({ TMUX: "x" }).graphics).toBe("none");
});

test("trueColor reads COLORTERM", () => {
  const h = detectHost({ TMUX: "x" });
  expect(h.capabilities({ COLORTERM: "truecolor" }).trueColor).toBe(true);
  expect(h.capabilities({}).trueColor).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/host/index.test.ts`
Expected: FAIL — cannot resolve module `./index`.

- [ ] **Step 3a: Implement `host/types.ts` — the leaf module**

```ts
export interface TerminalCapabilities {
  graphics: "kitty" | "iterm2" | "sixel" | "none";
  trueColor: boolean;
  mouse: boolean;
  columns: number;
  rows: number;
}

export interface PaneSpec {
  argv: string[];
  title: string;
  ratio: number;
}

export interface PaneHandle {
  host: string;
  wtSession?: string;
}

export interface CanvasHost {
  name: string;
  isAvailable(env: NodeJS.ProcessEnv): boolean;
  capabilities(env: NodeJS.ProcessEnv): TerminalCapabilities;
  buildArgv(spec: PaneSpec): string[];
  open(spec: PaneSpec): Promise<PaneHandle>;
}

// Phase 1 implements only what is free. Probing for Kitty, iTerm2 or Sixel
// support is Phase 3 work and must not be attempted here.
export function baseCapabilities(env: NodeJS.ProcessEnv): TerminalCapabilities {
  return {
    graphics: "none",
    trueColor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
    mouse: (env.TERM ?? "").length > 0 || process.platform === "win32",
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
```

- [ ] **Step 3b: Implement `host/index.ts` — detection only**

```ts
import type { CanvasHost } from "./types";
import { tmuxHost } from "./tmux";
import { windowsTerminalHost } from "./windows-terminal";

export * from "./types";

export class NoHostError extends Error {
  constructor() {
    super(
      "No canvas host available. Tried tmux (needs $TMUX — start a tmux session) " +
        "and Windows Terminal (needs $WT_SESSION — run inside Windows Terminal)."
    );
    this.name = "NoHostError";
  }
}

const HOSTS: CanvasHost[] = [tmuxHost, windowsTerminalHost];

export function detectHost(env: NodeJS.ProcessEnv = process.env): CanvasHost {
  const host = HOSTS.find((h) => h.isAvailable(env));
  if (!host) throw new NoHostError();
  return host;
}
```

Tasks 9 and 10 import from `./types`, never from `./index`, which is what keeps
the graph acyclic.

- [ ] **Step 4: Implement Tasks 9 and 10, then run this test**

`index.ts` imports both backends, so its test cannot pass until they exist.
This is an ordering dependency, not a cycle. Do Task 9 and Task 10, then:

Run: `bun test canvas/src/host/index.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/host/types.ts canvas/src/host/index.ts canvas/src/host/index.test.ts
git commit -m "feat: CanvasHost interface with runtime detection"
```

---

### Task 9: tmux backend

**Files:**
- Create: `canvas/src/host/tmux.ts`, `canvas/src/host/tmux.test.ts`

**Interfaces:**
- Consumes: `CanvasHost`, `PaneSpec`, `PaneHandle`, `baseCapabilities` from `host/types.ts` (Task 8). Never import from `host/index.ts` — that is the cycle.
- Produces: `tmuxHost: CanvasHost`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { tmuxHost } from "./tmux";

const spec = { argv: ["bun", "run", "cli.ts", "show", "document"], title: "canvas: document", ratio: 0.67 };

test("available only when TMUX is set", () => {
  expect(tmuxHost.isAvailable({ TMUX: "/tmp/s,1,0" })).toBe(true);
  expect(tmuxHost.isAvailable({})).toBe(false);
});

test("builds a split-window argv using -l, not the deprecated -p", () => {
  const argv = tmuxHost.buildArgv(spec);
  expect(argv[0]).toBe("tmux");
  expect(argv).toContain("split-window");
  expect(argv).toContain("-h");
  expect(argv).toContain("-l");
  expect(argv).toContain("67%");
  expect(argv).not.toContain("-p");
});

test("separates payload argv with -- so payload flags are not eaten", () => {
  const argv = tmuxHost.buildArgv(spec);
  const sep = argv.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(argv.slice(sep + 1)).toEqual(spec.argv);
});

test("never uses send-keys", () => {
  expect(tmuxHost.buildArgv(spec)).not.toContain("send-keys");
});

test("payload arguments stay separate elements, never joined into a string", () => {
  const argv = tmuxHost.buildArgv({ ...spec, argv: ["bun", "a b", "c;d"] });
  expect(argv).toContain("a b");
  expect(argv).toContain("c;d");
  expect(argv.some((a) => a.includes("bun a b"))).toBe(false);
});
```

The last test documents the boundary: argv arrays keep `;` inert for tmux. The Windows backend needs the Task 3 whitelist as well, which Task 10 tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/host/tmux.test.ts`
Expected: FAIL — cannot resolve module `./tmux`.

- [ ] **Step 3: Implement**

```ts
import { baseCapabilities, type CanvasHost, type PaneHandle, type PaneSpec } from "./types";

export const tmuxHost: CanvasHost = {
  name: "tmux",

  isAvailable(env) {
    return Boolean(env.TMUX);
  },

  capabilities(env) {
    return baseCapabilities(env);
  },

  buildArgv(spec: PaneSpec): string[] {
    // -l 67% replaces the deprecated -p 67. "--" keeps payload flags from
    // being parsed by tmux. No shell string anywhere.
    return [
      "tmux",
      "split-window",
      "-h",
      "-l",
      `${Math.round(spec.ratio * 100)}%`,
      "--",
      ...spec.argv,
    ];
  },

  async open(spec: PaneSpec): Promise<PaneHandle> {
    const argv = this.buildArgv(spec);
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tmux split-window failed (${code}): ${err.trim()}`);
    }
    return { host: "tmux" };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/host/tmux.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/host/tmux.ts canvas/src/host/tmux.test.ts
git commit -m "feat: tmux canvas host backend"
```

---

### Task 10: Windows Terminal backend

**Files:**
- Create: `canvas/src/host/windows-terminal.ts`, `canvas/src/host/windows-terminal.test.ts`

**Interfaces:**
- Consumes: `CanvasHost`, `PaneSpec`, `PaneHandle`, `baseCapabilities` from `host/types.ts` (Task 8). Never import from `host/index.ts`.
- Produces: `windowsTerminalHost: CanvasHost`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { windowsTerminalHost as wt } from "./windows-terminal";

const spec = { argv: ["bun", "run", "cli.ts", "show", "document"], title: "canvas: document", ratio: 0.66 };

test("available only when WT_SESSION is set", () => {
  expect(wt.isAvailable({ WT_SESSION: "guid" })).toBe(true);
  expect(wt.isAvailable({})).toBe(false);
});

test("always passes -w 0 to target the caller's existing window", () => {
  // Without -w 0, wt opens a brand new window (windowingBehavior defaults to
  // useNew). -w last targets the most-recently-USED window, which may not be
  // the caller's — unsafe.
  const argv = wt.buildArgv(spec);
  const i = argv.indexOf("-w");
  expect(i).toBeGreaterThan(0);
  expect(argv[i + 1]).toBe("0");
  expect(argv).not.toContain("last");
});

test("uses split-pane with -V for a side-by-side split", () => {
  const argv = wt.buildArgv(spec);
  expect(argv).toContain("split-pane");
  expect(argv).toContain("-V");
  expect(argv).not.toContain("-H");
});

test("passes --size for the new pane", () => {
  const argv = wt.buildArgv(spec);
  const i = argv.indexOf("--size");
  expect(i).toBeGreaterThan(0);
  expect(argv[i + 1]).toBe("0.66");
});

test("refuses any payload argument containing a semicolon", () => {
  // wt re-parses its own raw command line and splits on ";" even inside a
  // single correctly quoted argv element, turning one command into several.
  // argv arrays do not protect us here; this guard does.
  expect(() => wt.buildArgv({ ...spec, argv: ["bun", "run", "x;calc"] })).toThrow(/semicolon/i);
});

test("accepts a payload with no semicolon", () => {
  expect(() => wt.buildArgv(spec)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/host/windows-terminal.test.ts`
Expected: FAIL — cannot resolve module `./windows-terminal`.

- [ ] **Step 3: Implement**

```ts
import { baseCapabilities, type CanvasHost, type PaneHandle, type PaneSpec } from "./types";

export const windowsTerminalHost: CanvasHost = {
  name: "windows-terminal",

  isAvailable(env) {
    return Boolean(env.WT_SESSION);
  },

  capabilities(env) {
    return baseCapabilities(env);
  },

  buildArgv(spec: PaneSpec): string[] {
    // Defence in depth. Callers already validate id/kind/scenario against
    // ^[A-Za-z0-9_-]{1,64}$, but any semicolon reaching wt is an injection
    // into wt's own command grammar regardless of quoting, so refuse here too.
    for (const arg of spec.argv) {
      if (arg.includes(";")) {
        throw new Error(
          "Refusing to invoke wt.exe with an argument containing a semicolon: " +
            "wt splits its own command line on ';' even inside quoted arguments."
        );
      }
    }
    return [
      "wt.exe",
      "-w",
      "0", // mandatory: target the caller's existing window
      "split-pane",
      "-V", // side-by-side
      "--size",
      spec.ratio.toFixed(2),
      ...spec.argv,
    ];
  },

  async open(spec: PaneSpec): Promise<PaneHandle> {
    const argv = this.buildArgv(spec);
    // wt.exe is a GUI app: it returns 0 immediately and writes zero bytes to
    // stdout and stderr on every invocation, wt --help included. There is no
    // handle to capture and no close verb. The canvas closes its own pane by
    // exiting 0; see the lifecycle section of the spec.
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`wt.exe split-pane failed with exit code ${code}`);
    return { host: "windows-terminal", wtSession: process.env.WT_SESSION };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/host/windows-terminal.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the Task 8 detection tests, now that both backends exist**

Run: `bun test canvas/src/host/`
Expected: PASS, all 17 tests across the three files.

- [ ] **Step 6: Commit**

```bash
git add canvas/src/host/windows-terminal.ts canvas/src/host/windows-terminal.test.ts
git commit -m "feat: Windows Terminal canvas host with semicolon guard"
```

---

### Task 11: The single canvas hook

**Files:**
- Create: `canvas/src/runtime/use-canvas-server.ts`
- Create: `canvas/src/runtime/use-canvas-server.test.tsx`

**Interfaces:**
- Consumes: `startCanvasServer` (Task 6); `writeRecord`, `deleteRecord`, `newToken` (Task 5); `logPath` (Task 2); `detectHost` (Task 8).
- Produces:

```ts
export interface UseCanvasServerOptions {
  id: string; kind: string; scenario: string;
  enabled: boolean;             // false in tests and in `show` without a socket
  onUpdate?(config: unknown): void;
  onGet?(key: string): unknown;
  onClose?(): void;
}
export interface CanvasServerHandle {
  isConnected: boolean;
  sendSelected(data: unknown): void;
  sendCancelled(reason?: string): void;
  sendError(message: string): void;
}
export function useCanvasServer(o: UseCanvasServerOptions): CanvasServerHandle
```

`enabled` replaces the old "is socketPath truthy" test, which was an implicit way of saying the same thing.

- [ ] **Step 1: Write the failing test**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import { useCanvasServer } from "./use-canvas-server";
import { renderCanvas } from "../../test/harness/render";

function Probe() {
  const ipc = useCanvasServer({ id: "hook-off", kind: "document", scenario: "display", enabled: false });
  return <Box><Text>connected={String(ipc.isConnected)}</Text></Box>;
}

test("disabled hook renders without opening a server", async () => {
  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  expect(await r.settle()).toContain("connected=false");
  r.dispose();
});

test("disabled hook sends are safe no-ops", async () => {
  function Sender() {
    const ipc = useCanvasServer({ id: "hook-off2", kind: "document", scenario: "display", enabled: false });
    ipc.sendSelected({ a: 1 });
    ipc.sendCancelled("x");
    ipc.sendError("y");
    return <Text>ok</Text>;
  }
  const r = renderCanvas(<Sender />, { columns: 20, rows: 3 });
  expect(await r.settle()).toContain("ok");
  r.dispose();
});
```

Server-side behaviour is already covered by Tasks 6 and 7; these tests pin the offline path that every render snapshot depends on.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/runtime/use-canvas-server.test.tsx`
Expected: FAIL — cannot resolve module `./use-canvas-server`.

- [ ] **Step 3: Implement**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "ink";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { startCanvasServer, type CanvasServer } from "./server";
import { deleteRecord, writeRecord } from "./registry";
import { logPath } from "./paths";
import { detectHost } from "../host";
import type { CanvasMessage } from "./protocol";

export interface UseCanvasServerOptions {
  id: string;
  kind: string;
  scenario: string;
  enabled: boolean;
  onUpdate?(config: unknown): void;
  onGet?(key: string): unknown;
  onClose?(): void;
}

export interface CanvasServerHandle {
  isConnected: boolean;
  sendSelected(data: unknown): void;
  sendCancelled(reason?: string): void;
  sendError(message: string): void;
}

// Never console.log from canvas code: it writes over the Ink render.
async function logToFile(id: string, message: string): Promise<void> {
  try {
    const path = logPath(id);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never take the canvas down.
  }
}

export function useCanvasServer(o: UseCanvasServerOptions): CanvasServerHandle {
  const { id, kind, scenario, enabled } = o;
  const { exit } = useApp();
  const [isConnected, setIsConnected] = useState(false);
  const serverRef = useRef<CanvasServer | null>(null);
  const cbs = useRef(o);

  useEffect(() => {
    cbs.current = o;
  }, [o]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;

    (async () => {
      try {
        const host = detectHost();
        const server = await startCanvasServer({
          onMessage(msg, reply) {
            switch (msg.type) {
              case "update":
                cbs.current.onUpdate?.(msg.config);
                break;
              case "get":
                reply({ type: "value", key: msg.key, data: cbs.current.onGet?.(msg.key) ?? null });
                break;
              case "ping":
                reply({ type: "pong" });
                break;
              case "close":
                cbs.current.onClose?.();
                exit();
                break;
            }
          },
          onError(e) {
            void logToFile(id, `ipc error: ${e.message}`);
          },
        });
        if (!live) {
          server.stop();
          return;
        }
        serverRef.current = server;
        await writeRecord({
          id, kind, scenario,
          port: server.port, token: server.token, pid: process.pid,
          startedAt: new Date().toISOString(),
          host: host.name,
          wtSession: process.env.WT_SESSION,
        });
        setIsConnected(true);
        server.broadcast({ type: "ready", scenario, capabilities: host.capabilities(process.env) });
      } catch (e) {
        // A canvas must still exit 0, so the failure travels in the record.
        void logToFile(id, `startup failed: ${(e as Error).message}`);
        await writeRecord({
          id, kind, scenario, port: 0, token: "", pid: process.pid,
          startedAt: new Date().toISOString(), host: "none",
          lastError: (e as Error).message,
        }).catch(() => {});
      }
    })();

    return () => {
      live = false;
      serverRef.current?.stop();
      serverRef.current = null;
      void deleteRecord(id);
    };
  }, [enabled, id, kind, scenario, exit]);

  const send = useCallback((msg: CanvasMessage) => {
    serverRef.current?.broadcast(msg);
  }, []);

  return {
    isConnected,
    sendSelected: useCallback((data: unknown) => send({ type: "selected", data }), [send]),
    sendCancelled: useCallback((reason?: string) => send({ type: "cancelled", reason }), [send]),
    sendError: useCallback((message: string) => send({ type: "error", message }), [send]),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/runtime/use-canvas-server.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add canvas/src/runtime/use-canvas-server.ts canvas/src/runtime/use-canvas-server.test.tsx
git commit -m "feat: single canvas server hook, replacing both IPC hooks"
```

---

### Task 12: CLI rewrite

**Files:**
- Modify: `canvas/src/cli.ts` (full rewrite, 215 lines → smaller)
- Create: `canvas/src/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-11.
- Produces: the CLI surface `show`, `spawn`, `wait`, `get`, `close`, `list`, `env`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { emit, resolveWaitTimeout } from "./cli";

test("emit prints exactly one JSON object", () => {
  const lines: string[] = [];
  const write = (s: string) => { lines.push(s); return true; };
  emit({ status: "pending" }, write as never);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "")).toEqual({ status: "pending" });
});

test("wait timeout defaults below the Bash tool's 120s limit", () => {
  expect(resolveWaitTimeout(undefined)).toBe(55_000);
  expect(resolveWaitTimeout("10")).toBe(10_000);
});

test("wait timeout rejects nonsense", () => {
  expect(() => resolveWaitTimeout("abc")).toThrow();
  expect(() => resolveWaitTimeout("-5")).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/cli.test.ts`
Expected: FAIL — `emit` and `resolveWaitTimeout` are not exported from `./cli`.

- [ ] **Step 3: Rewrite the CLI**

Replace the whole file. Key shape:

```ts
#!/usr/bin/env bun
import { program } from "commander";
import { assertIdent } from "./runtime/validate";
import { configPath } from "./runtime/paths";
import { getValue, requestClose, waitForOutcome, DEFAULT_WAIT_MS } from "./runtime/client";
import { listRecords } from "./runtime/registry";
import { detectHost } from "./host";

type Writer = (s: string) => boolean;

// Every command prints exactly one JSON object on stdout. Diagnostics go to
// stderr so they can never corrupt what Claude parses.
export function emit(value: unknown, write: Writer = process.stdout.write.bind(process.stdout)): void {
  write(`${JSON.stringify(value)}\n`);
}

export function resolveWaitTimeout(seconds: string | undefined): number {
  if (seconds === undefined) return DEFAULT_WAIT_MS;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --timeout: ${seconds}`);
  return Math.round(n * 1000);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  emit({ status: "error", message });
  process.exit(1);
}

program.name("claude-canvas").version("1.0.0");

program
  .command("show <kind>")
  .option("--id <id>").option("--scenario <name>").option("--config-file <path>")
  .option("--offline", "render without opening a server (used by tests)")
  .action(async (kind: string, opts) => {
    const id = assertIdent("id", opts.id ?? `${kind}-1`);
    assertIdent("kind", kind);
    const scenario = assertIdent("scenario", opts.scenario ?? "display");
    const config = opts.configFile ? await Bun.file(opts.configFile).json() : undefined;
    process.stdout.write(`\x1b]0;canvas: ${kind}\x07`);
    const { renderCanvas } = await import("./canvases");
    await renderCanvas(kind, id, config, { scenario, enabled: !opts.offline });
    // Always exit 0: a non-zero exit leaves an unremovable pane on Windows.
    process.exit(0);
  });

program
  .command("spawn <kind>")
  .option("--id <id>").option("--scenario <name>").option("--config <json>")
  .action(async (kind: string, opts) => {
    const id = assertIdent("id", opts.id ?? `${kind}-1`);
    assertIdent("kind", kind);
    const scenario = assertIdent("scenario", opts.scenario ?? "display");
    const argv = [process.execPath, "run", `${import.meta.dir}/cli.ts`, "show", kind,
      "--id", id, "--scenario", scenario];
    if (opts.config) {
      // Config travels by file: Windows caps a command line near 32 KB, and
      // Phase 3 screenshots would blow past it.
      const path = configPath(id);
      await Bun.write(path, opts.config);
      argv.push("--config-file", path);
    }
    try {
      const host = detectHost();
      const handle = await host.open({ argv, title: `canvas: ${kind}`, ratio: 0.67 });
      emit({ status: "spawned", id, host: handle.host });
    } catch (e) {
      fail((e as Error).message);
    }
  });

program
  .command("wait <id>")
  .option("--timeout <seconds>")
  .action(async (id: string, opts) => {
    assertIdent("id", id);
    const result = await waitForOutcome(id, resolveWaitTimeout(opts.timeout));
    emit(result);
    process.exit(result.status === "disconnected" || result.status === "error" ? 1 : 0);
  });

program.command("get <id> <key>").action(async (id: string, key: string) => {
  assertIdent("id", id);
  assertIdent("key", key);
  try {
    emit({ status: "ok", key, data: await getValue(id, key) });
  } catch (e) {
    fail((e as Error).message);
  }
});

program.command("close <id>").action(async (id: string) => {
  assertIdent("id", id);
  try {
    // Ask, never kill. Killing leaves a zombie pane on Windows.
    await requestClose(id);
    emit({ status: "closing", id });
  } catch (e) {
    fail((e as Error).message);
  }
});

program.command("list").action(async () => {
  emit({ status: "ok", canvases: await listRecords() });
});

program.command("env").action(() => {
  try {
    const host = detectHost();
    emit({ status: "ok", host: host.name, capabilities: host.capabilities(process.env) });
  } catch (e) {
    emit({ status: "ok", host: null, message: (e as Error).message });
  }
});

if (import.meta.main) program.parse();
```

`if (import.meta.main)` is what lets `cli.test.ts` import the module without running the parser.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test canvas/src/cli.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Smoke-test the offline render path**

Run: `bun run canvas/src/cli.ts env`
Expected: one JSON object naming the detected host, or `"host": null` with a message outside tmux and Windows Terminal.

- [ ] **Step 6: Commit**

```bash
git add canvas/src/cli.ts canvas/src/cli.test.ts
git commit -m "feat: rewrite CLI with wait/get/close/list and JSON output"
```

---

### Task 13: Migrate the three canvases and delete the old layers

Sequenced document → flight → calendar: document already uses the server model so it validates the new protocol with the least change; calendar's meeting-picker is the most tangled and is therefore the strongest evidence the design holds.

**Files:**
- Modify: `canvas/src/canvases/index.tsx`, `canvas/src/canvases/document.tsx`, `canvas/src/canvases/flight.tsx`, `canvas/src/canvases/calendar.tsx`, `canvas/src/canvases/calendar/scenarios/meeting-picker-view.tsx`, `canvas/src/canvases/calendar/hooks/index.ts`
- Modify: `canvas/src/scenarios/registry.ts`, `canvas/src/scenarios/index.ts`
- Create: `canvas/src/scenarios/flight/booking.ts`
- Delete: `canvas/src/api/`, `canvas/src/ipc/`, `canvas/src/canvases/calendar/hooks/use-ipc.ts`, `canvas/src/canvases/calendar/hooks/use-ipc-server.ts`, `canvas/src/terminal.ts`, `canvas/run-canvas.sh`

**Interfaces:**
- Consumes: `useCanvasServer` (Task 11).
- Produces: `renderCanvas(kind, id, config, { scenario, enabled })` from `canvas/src/canvases/index.tsx`.

- [ ] **Step 1: Change the render entry point signature**

In `canvas/src/canvases/index.tsx`, replace `RenderOptions` `{ socketPath?, scenario? }` with `{ scenario?: string; enabled: boolean }` and thread `enabled` into all three canvases instead of `socketPath`. Keep `clearScreen`/`showCursor` as they are.

- [ ] **Step 2: Migrate `document.tsx`**

Replace the `useIPCServer` import from `./calendar/hooks/use-ipc-server` with `useCanvasServer` from `../runtime/use-canvas-server`. Map the old callbacks onto the new shape: `onGetSelection` and `onGetContent` collapse into one `onGet(key)` returning the selection for `"selection"`, the content for `"content"`, and the config for `"config"`.

- [ ] **Step 3: Update the document snapshot props and run**

The snapshot test passes `socketPath={undefined}`; change it to `enabled={false}`.

Run: `bun test canvas/test/snapshots/document.test.tsx`
Expected: PASS with **no snapshot change**. A diff here means the migration altered rendering — investigate before proceeding, do not update the snapshot.

- [ ] **Step 4: Commit document**

```bash
git add canvas/src/canvases/document.tsx canvas/src/canvases/index.tsx canvas/test/snapshots/document.test.tsx
git commit -m "refactor: migrate document canvas to unified IPC"
```

- [ ] **Step 5: Migrate `flight.tsx` and register its scenarios**

Swap `useIPC` for `useCanvasServer`. This canvas flips from client to server — the reason its selections never reached Claude.

`canvas/src/scenarios/flight/booking.ts`:

```ts
import type { ScenarioDefinition } from "../types";

export const flightBookingScenario: ScenarioDefinition = {
  name: "booking",
  description: "Compare flights and select a seat",
  canvasKind: "flight",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
```

Register it in `canvas/src/scenarios/registry.ts` with `registry.set("flight:booking", flightBookingScenario)` and export it from `canvas/src/scenarios/index.ts`, which currently exports only calendar scenarios.

- [ ] **Step 6: Run the flight snapshot**

Run: `bun test canvas/test/snapshots/flight.test.tsx`
Expected: PASS with no snapshot change.

Add a test asserting `getScenario("flight", "booking")` is defined — it returns `undefined` today.

- [ ] **Step 7: Commit flight**

```bash
git add canvas/src/canvases/flight.tsx canvas/src/scenarios canvas/test
git commit -m "refactor: migrate flight canvas to unified IPC and register its scenario"
```

- [ ] **Step 8: Migrate calendar, and fix its conditional hook call**

Swap `useIPC` for `useCanvasServer` in `meeting-picker-view.tsx`.

Separately, `calendar.tsx:348-364` returns `<MeetingPickerView/>` **before** calling `useApp()` and `useStdout()`, so hooks run conditionally — a rules-of-hooks violation that works only because the scenario never changes during a mount. Split the component: `Calendar` becomes a thin router that calls no hooks, delegating to `CalendarDisplay` (holding the current hooks and body) and `MeetingPickerView`.

- [ ] **Step 9: Run the calendar snapshots**

Run: `bun test canvas/test/snapshots/calendar.test.tsx`
Expected: PASS with no snapshot change, for both the `display` and `meeting-picker` cases.

- [ ] **Step 10: Delete the dead layers**

```bash
git rm -r canvas/src/api canvas/src/ipc
git rm canvas/src/canvases/calendar/hooks/use-ipc.ts canvas/src/canvases/calendar/hooks/use-ipc-server.ts
git rm canvas/src/terminal.ts canvas/run-canvas.sh
```

Remove `export * from "./use-ipc"` from `canvas/src/canvases/calendar/hooks/index.ts`. `run-canvas.sh` goes because the host now invokes `bun` directly through an argv array; it was a bash-shebang script, so this removes another Unix-only dependency.

- [ ] **Step 11: Run the whole suite**

Run: `bun test`
Expected: PASS, everything. No import can still reference a deleted module.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: migrate calendar canvas, fix conditional hooks, delete old IPC layers"
```

---

### Task 14: Fix the two render-layer defects

**Files:**
- Modify: `canvas/src/canvases/calendar/hooks/use-mouse.ts:102,155`
- Modify: `canvas/src/canvases/document.tsx` (duplicate key)
- Create: `canvas/src/canvases/calendar/hooks/use-mouse.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test for mouse cleanup**

```ts
import { test, expect } from "bun:test";
import { MOUSE_ENABLE, MOUSE_DISABLE, withMouseTracking } from "./use-mouse";

test("mouse tracking is disabled even when the body throws", () => {
  const writes: string[] = [];
  expect(() =>
    withMouseTracking((s) => writes.push(s), () => { throw new Error("boom"); })
  ).toThrow("boom");
  expect(writes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
});

test("mouse tracking writes through the injected sink, not process.stdout", () => {
  const writes: string[] = [];
  withMouseTracking((s) => writes.push(s), () => {});
  expect(writes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test canvas/src/canvases/calendar/hooks/use-mouse.test.ts`
Expected: FAIL — `withMouseTracking`, `MOUSE_ENABLE`, `MOUSE_DISABLE` are not exported.

- [ ] **Step 3: Implement**

Export the two escape constants and a `withMouseTracking(write, body)` helper that always emits `MOUSE_DISABLE` in a `finally`. Change the hook to take its write sink as a parameter defaulting to `process.stdout.write.bind(process.stdout)`, and register a `process.on("exit")` handler that emits `MOUSE_DISABLE` — today a canvas dying before cleanup strands the user's terminal in SGR mouse mode.

- [ ] **Step 4: Fix the duplicate React key**

Find the list in `document.tsx` whose children share a key and make the key unique — index-suffixed if the content genuinely repeats. Run the document snapshot and confirm no diff and no warning on stderr.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: PASS, and no `Encountered two children with the same key` on stderr.

- [ ] **Step 6: Commit**

```bash
git add canvas/src/canvases
git commit -m "fix: keep mouse escapes off the real stdout and unique document keys"
```

---

### Task 15: Mechanical type fixes — the JSX namespace

13 errors, all `TS2503 Cannot find namespace 'JSX'`. Not the original author's doing: React 19 removed the global `JSX` namespace in favour of `React.JSX`.

**Files:**
- Modify: `canvas/src/canvases/calendar.tsx` (5 occurrences at :184, :214, :453, :467, :505) and every other file the compiler reports.

- [ ] **Step 1: Get the exact list**

Run: `bun x tsc --noEmit 2>&1 | grep TS2503`
Expected: 13 lines. Record the count.

- [ ] **Step 2: Replace `JSX.` with `React.JSX.`**

Only inside type positions, e.g. `JSX.Element` → `React.JSX.Element`. Ensure each touched file imports React.

- [ ] **Step 3: Confirm those 13 are gone and no others appeared**

Run: `bun x tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: **97**.

The arithmetic, since it is easy to get wrong: the repo starts at 113, Task 13
deletes `src/api/` which removes its 3, leaving 110 when this task begins.
Fixing these 13 leaves 97 for Task 16. None of the 13 `TS2503` errors live in
`api/canvas-api.ts`, so they do not overlap with the 3 already gone.

- [ ] **Step 4: Confirm rendering is unchanged**

Run: `bun test`
Expected: PASS, no snapshot diffs. Type-only edits must not move a pixel.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: use React.JSX namespace for React 19"
```

---

### Task 16: The remaining type errors, file by file

**97 errors**, almost all `noUncheckedIndexedAccess` fallout (TS2532, TS18048, TS2345, TS2322). Not cosmetic: `Date | undefined` reaches `new Date()` and comparisons.

(The spec says "~98". 97 is the exact figure: 113 total, minus the 3 in the
deleted `src/api/`, minus the 13 `JSX` renames from Task 15.)

**Files, in ascending order of error count** so the pattern is learned on small files first:

1. `canvas/src/canvases/calendar/types.ts` (1)
2. `canvas/src/canvases/flight/types.ts` (2)
3. `canvas/src/canvases/calendar/hooks/use-mouse.ts` (3)
4. `canvas/src/canvases/document.tsx` (5)
5. `canvas/src/canvases/calendar.tsx` (7, minus any JSX ones already fixed)
6. `canvas/src/canvases/flight/components/seat-row.tsx` (7)
7. `canvas/src/canvases/flight/components/seatmap-panel.tsx` (9)
8. `canvas/src/canvases/calendar/scenarios/meeting-picker-view.tsx` (19)
9. `canvas/src/canvases/document/components/raw-markdown-renderer.tsx` (20)
10. `canvas/src/canvases/document/components/markdown-renderer.tsx` (37)

**Repeat these four steps for each file, committing per file.** Ten small commits beat one large one: a snapshot diff then has exactly one file to blame.

- [ ] **Step 1: List that file's errors**

Run: `bun x tsc --noEmit 2>&1 | grep "<file>"`

- [ ] **Step 2: Fix them**

The three legitimate patterns, in order of preference:

```ts
// 1. Narrow with a guard when absence is genuinely possible.
const first = items[0];
if (!first) return null;

// 2. Destructure with a default when a sensible fallback exists.
const { [key]: value = fallback } = map;

// 3. Assert ONLY where an invariant makes it impossible, with the reason.
// slots is built with length >= 1 directly above, so index 0 exists.
const slot = slots[0]!;
```

Do **not** widen a type to `| undefined` to silence the compiler, do not add `as any`, and do not disable the rule.

- [ ] **Step 3: Verify the file is clean and rendering is unchanged**

Run: `bun x tsc --noEmit 2>&1 | grep -c "<file>"` → expect 0.
Run: `bun test` → expect PASS, no snapshot diff.

If a snapshot **does** change, the fix altered behaviour. That is the harness doing its job: revert and choose a different pattern. Update a snapshot only when you can state why the new output is correct, and say so in the commit message.

- [ ] **Step 4: Commit**

```bash
git add <file>
git commit -m "fix: satisfy noUncheckedIndexedAccess in <file>"
```

- [ ] **Step 5: After all ten files, confirm zero**

Run: `bun x tsc --noEmit`
Expected: no output, exit 0. Down from 113.

---

### Task 17: Update the four skills

The skills are how Claude learns to use this. They currently instruct it to import `src/api/` (deleted in Task 13) and call a `bookFlight` that never existed. Migrating the code without the skills leaves Claude calling deleted code.

**Files:**
- Modify: `canvas/skills/canvas/SKILL.md` (drop the "High-Level API" section at :90), `canvas/skills/calendar/SKILL.md` (:130), `canvas/skills/flight/SKILL.md` (:147), `canvas/skills/document/SKILL.md`
- Modify: `canvas/README.md`, `canvas/CLAUDE.md`

- [ ] **Step 1: Remove every reference to the deleted API**

Run: `grep -rn "src/api\|bookFlight\|pickMeetingTime\|editDocument\|displayCalendar" canvas/`
Expected after editing: no matches.

- [ ] **Step 2: Replace the IPC section of `skills/canvas/SKILL.md`**

Document the real surface: the message table from the spec, and the CLI verbs with the interaction pattern Claude should follow.

```markdown
## Interacting with a canvas

    # Open a canvas beside the conversation
    bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn calendar \
      --scenario meeting-picker --id cal-1 --config '{...}'

    # Block for the user's choice. Returns within ~55s no matter what.
    bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts wait cal-1

Every command prints one JSON object. `wait` returns one of
`{"status":"selected","data":...}`, `{"status":"cancelled"}`,
`{"status":"pending"}` (timed out, canvas still alive — call `wait` again),
`{"status":"disconnected"}`, or `{"status":"error","message":...}`.

`get <id> <key>` reads state (`selection`, `content`, `config`);
`close <id>` asks the canvas to exit; `list` shows live canvases.
```

- [ ] **Step 3: Remove tmux from the stated requirements**

All four skills and `canvas/README.md` say tmux is required. It is now one of two backends; Windows Terminal is the other. Say that instead.

- [ ] **Step 4: Update `canvas/CLAUDE.md`**

Its structure diagram lists `ipc/` and `api/`, both deleted. Replace with `runtime/` and `host/`, and replace the IPC protocol section with the current message table.

- [ ] **Step 5: Commit**

```bash
git add canvas/skills canvas/README.md canvas/CLAUDE.md
git commit -m "docs: point skills at the real CLI surface"
```

---

### Task 18: CI and lockfile

**Files:**
- Create: `.github/workflows/ci.yml`
- Add: `bun.lock`

**Interfaces:**
- Consumes: the full test suite.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the workflow**

Mirrors the structure of `claude-skills/.github/workflows/test-skills.yml`. The Windows leg is the point: it is what stops Unix-only assumptions from creeping back.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    name: ${{ matrix.os }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2

      - name: Install
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun x tsc --noEmit

      - name: Test
        run: bun test
```

`bun x tsc --noEmit` would have caught the `src/api/` breakage the day it landed.

- [ ] **Step 2: Commit the lockfile**

The lockfile was removed in `d5e1548`, so installs are not reproducible and `--frozen-lockfile` would fail.

```bash
git add bun.lock .github/workflows/ci.yml
git commit -m "ci: matrix build on ubuntu and windows, commit lockfile"
```

- [ ] **Step 3: Verify both legs locally as far as possible**

Run: `bun install --frozen-lockfile && bun x tsc --noEmit && bun test`
Expected: all three succeed, zero type errors.

- [ ] **Step 4: Push and confirm CI is green on both platforms**

If the Windows leg fails where Linux passes, it is almost certainly a path assumption — check `paths.ts` first.

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks:

| Spec section | Task |
|---|---|
| Canvas-as-server | 6, 11 |
| TCP transport, ephemeral port | 6 |
| Protocol + framing + 16 MB ceiling | 4 |
| Handshake / token auth | 5 (token), 6 (enforcement) |
| `get`/`value` replacing `getSelection`/`getContent` | 4, 11, 13 |
| Waiting via `wait`, 55s, five statuses | 7, 12 |
| One JSON object per command, exit codes | 12 |
| Registry, one file per canvas, liveness, `lastError` | 5 |
| Cross-platform `dataDir`, no `/tmp` | 2 |
| `CanvasHost` + capabilities, `graphics: "none"` | 8 |
| tmux backend, `-l` not `-p` | 9 |
| wt backend, `-w 0`, `-V`, `--size` | 10 |
| Injection: argv arrays + whitelist + `;` guard | 3, 9, 10 |
| Config by file | 12 |
| Pane lifecycle, always exit 0, never kill | 11, 12 |
| Deleting `api/`, `ipc/`, hooks, `terminal.ts`, `run-canvas.sh` | 13 |
| Migration order document → flight → calendar | 13 |
| Registering `flight` scenarios | 13 |
| Render snapshots first, harness requirements | 1 |
| `setSystemTime` clock pinning | 1 |
| 113 type errors → 0 | 15, 16 |
| Defect 9 (mouse stdout) and 10 (duplicate key) | 14 |
| Skills updated | 17 |
| CI matrix + lockfile | 18 |
| Error handling: two exit-code rules | 11, 12 |

No spec requirement is unassigned. Two additions beyond the spec, both discovered while planning: the conditional hook call in `calendar.tsx:348` (Task 13 Step 8) and the `import.meta.main` guard needed to make the CLI testable (Task 12).

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Two steps are deliberately descriptive rather than code: Task 16 covers ~98 near-identical edits across ten files, so it gives the three permitted patterns plus an exact per-file list and count rather than 98 diffs; and Task 17 Step 1 is a `grep`-verified deletion. Both are checkable by the command given.

**Type consistency.** `assertIdent(field, value)` is used with that signature in Tasks 5, 10 and 12. `CanvasRecord` fields written in Task 5 are read identically in Tasks 7 and 11. `renderCanvas` from the test harness (Task 1) and `renderCanvas` from `canvases/index.tsx` (Task 13) collide by name but live in different modules and are never imported together — flagged so no one merges them. `buildArgv` is separated from `open` on `CanvasHost` specifically so Tasks 9 and 10 can assert on argv without spawning anything.
