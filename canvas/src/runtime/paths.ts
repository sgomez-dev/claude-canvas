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
