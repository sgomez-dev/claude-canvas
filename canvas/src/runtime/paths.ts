import { homedir } from "node:os";
import { join } from "node:path";

const APP = "claude-canvas";

export function dataDir(): string {
  // Test-only escape hatch. Without it, running the test suite reads,
  // writes to, and PRUNES the real machine-global registry directory --
  // which is also used by any real canvas the developer has running at the
  // time. That caused genuine, reproducible test interference (a stale
  // record left by an interrupted run failed unrelated tests later). Wired
  // up by test/setup.ts to a per-run temp directory; unset in normal use, so
  // production behavior is completely unchanged.
  const override = process.env.CANVAS_DATA_DIR;
  if (override) return override;
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
