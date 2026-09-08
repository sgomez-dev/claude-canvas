import { mkdir, unlink, chmod, readdir } from "node:fs/promises";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { canvasesDir, recordPath } from "./paths";
import { assertIdent } from "./validate";
import type { OutcomeMessage } from "./protocol";
export { newToken } from "./token";

/**
 * How long a record that exists only to carry an unread outcome is kept.
 * A controller that never calls `wait` would otherwise leave one behind
 * forever; an hour is far longer than any real spawn-to-wait gap.
 */
const OUTCOME_TTL_MS = 60 * 60 * 1000;

export interface CanvasRecord {
  id: string; kind: string; scenario: string;
  port: number; token: string; pid: number;
  startedAt: string; host: string;
  wtSession?: string; lastError?: string;
  /**
   * Set once the canvas has produced its terminal outcome, and written
   * before the process exits. This is what makes an outcome survive the
   * canvas: a broadcast only reaches controllers connected at that instant,
   * so without this a selection made before `wait` connected was gone for
   * good.
   */
  outcome?: OutcomeMessage;
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

/**
 * Synchronous sibling of writeRecord, for the one caller that needs it: a
 * canvas persisting its outcome. The component calls exit() as soon as the
 * outcome is sent, and process.exit does not wait for a pending async
 * write, so an awaited write here would lose the race it exists to win.
 */
export function writeRecordSync(r: CanvasRecord): void {
  assertIdent("id", r.id);
  mkdirSync(canvasesDir(), { recursive: true });
  const path = recordPath(r.id);
  writeFileSync(path, JSON.stringify(r, null, 2));
  if (process.platform !== "win32") chmodSync(path, 0o600);
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
  // Same reasoning, and the whole point of persisting an outcome: the
  // canvas has already exited by design, and its answer must outlive it.
  // Consumed (and deleted) by the controller that reads it.
  if (r.outcome) return r;
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
    // readRecord calls assertIdent internally, which throws on a basename
    // that isn't a valid identifier. A stray/malformed filename in the
    // canvases dir must not take down `list` for every other canvas — skip
    // it rather than let the throw escape.
    let r: CanvasRecord | null;
    try {
      r = await readRecord(name.slice(0, -5));
    } catch {
      continue;
    }
    if (!r) continue;
    if (r.lastError) continue;
    if (r.outcome) {
      // Not a live canvas, so it does not belong in `list`. Pruned here
      // rather than anywhere else because `list` is the natural sweep
      // point, and only once it is both dead and stale -- deleting a fresh
      // one would destroy an outcome a controller is about to read.
      const age = Date.now() - Date.parse(r.startedAt);
      if (!isAlive(r.pid) && Number.isFinite(age) && age > OUTCOME_TTL_MS) {
        await deleteRecord(r.id);
      }
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * Polls until a record for `id` exists, or the timeout elapses. Used by
 * `spawn`, which otherwise reported success the moment the pane was opened
 * -- before the canvas inside it had booted Bun, mounted Ink, started its
 * server and written its record. A `wait` issued immediately after such a
 * `spawn` answered "no canvas <id>" for a canvas that was merely still
 * starting; measured window on this machine, 0-1 s.
 */
export async function awaitRecord(id: string, timeoutMs: number): Promise<CanvasRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await readRecord(id);
    if (r) return r;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, 50));
  }
}

export async function deleteRecord(id: string): Promise<void> {
  assertIdent("id", id);
  try {
    await unlink(recordPath(id));
  } catch {
    // already gone
  }
}
