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

// bunfig.toml (repo root) preloads canvas/test/setup.ts, which pins
// TZ=UTC and FORCE_COLOR before any test file runs. That preload only
// fires when `bun test` is invoked from the repository root — bunfig.toml
// is not discovered from inside canvas/. Skip that discovery and the pins
// are silently absent: colour goes unpinned and canvas clocks render in
// the host's local timezone instead of UTC, so every snapshot that bakes
// in a rendered time or an ANSI code diverges from its baseline with zero
// production-code change. That's exactly the four snapshots this harness
// captures. Checked here (at call time, not at module import time) so the
// failure is a readable Error attached to the failing test rather than an
// opaque toMatchSnapshot diff four tests deep, and so a later reader isn't
// tempted to "fix" it by regenerating baselines under the wrong pins —
// which would silently replace the correct baselines with wrong ones.
//
// This intentionally does NOT set process.env itself to paper over a
// missing preload: Ink decides colour support when its own module is
// imported, before this function ever runs, so setting FORCE_COLOR here
// would be too late to change Ink's behaviour and would just hide the
// real problem.
function assertTestPreloadRan(): void {
  const tz = process.env.TZ;
  const forceColor = process.env.FORCE_COLOR;
  const tzOk = tz === "UTC";
  const colorOk = forceColor !== undefined && forceColor !== "0";
  if (tzOk && colorOk) return;

  throw new Error(
    "Canvas snapshot harness: the test preload did not run.\n" +
      "Snapshots require TZ=UTC and FORCE_COLOR set to a non-\"0\" value, " +
      "both pinned by canvas/test/setup.ts via the [test].preload entry in " +
      "bunfig.toml.\n" +
      "bunfig.toml lives at the REPOSITORY ROOT, not inside canvas/ — run " +
      "`bun test` from the repository root, not from canvas/.\n" +
      `Got TZ=${JSON.stringify(tz)} (expected "UTC"), ` +
      `FORCE_COLOR=${JSON.stringify(forceColor)} (must be set and not "0").`
  );
}

export function renderCanvas(
  node: ReactElement,
  opts: { columns?: number; rows?: number } = {}
): RenderResult {
  assertTestPreloadRan();

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
