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
