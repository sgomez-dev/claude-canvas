import { mkdir, unlink, chmod, readdir, rename } from "node:fs/promises";
import { mkdirSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
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

// Records are written to a sibling temp file and renamed into place, never
// written in place. Neither `Bun.write` nor `writeFileSync` is atomic, so a
// reader could otherwise observe a half-written file -- and `readRecord`
// used to DELETE anything that failed to parse, so a concurrent read during
// a write destroyed a perfectly good record and nothing ever rewrote it.
//
// That is exactly what failed on windows-latest in CI run 34276286536, and
// only there: `awaitRecord` polled for 5 s while the record it was waiting
// for had already been deleted by its own first read. rename() replaces the
// destination atomically on POSIX and via MOVEFILE_REPLACE_EXISTING on
// Windows, so no reader ever sees a partial record.
function tmpPath(path: string): string {
  return `${path}.${process.pid}.tmp`;
}

export async function writeRecord(r: CanvasRecord): Promise<void> {
  assertIdent("id", r.id);
  await mkdir(canvasesDir(), { recursive: true });
  const path = recordPath(r.id);
  const tmp = tmpPath(path);
  await Bun.write(tmp, JSON.stringify(r, null, 2));
  // Permissions are set on the temp file, before it becomes visible under
  // its real name: a token must never be world-readable, even briefly.
  if (process.platform !== "win32") await chmod(tmp, 0o600);
  await rename(tmp, path);
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
  const tmp = tmpPath(path);
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export async function readRecord(id: string): Promise<CanvasRecord | null> {
  assertIdent("id", id);
  const file = Bun.file(recordPath(id));
  if (!(await file.exists())) return null;
  let r: CanvasRecord;
  try {
    r = (await file.json()) as CanvasRecord;
  } catch {
    // Deliberately NOT deleted. Reading is not the place to destroy state:
    // this used to unlink anything unparseable, which turned a transient
    // read of a half-written file into permanent data loss. Writes are
    // atomic now, so an unparseable record means real corruption -- and
    // `listRecords`, which runs when nothing is mid-write, is where it gets
    // pruned.
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
    // Leftover temp files from a crashed write: not records, and not
    // something to report.
    if (name.endsWith(".tmp")) {
      await unlink(join(canvasesDir(), name)).catch(() => {});
      continue;
    }
    if (!name.endsWith(".json")) continue;
    // readRecord calls assertIdent internally, which throws on a basename
    // that isn't a valid identifier. A stray/malformed filename in the
    // canvases dir must not take down `list` for every other canvas — skip
    // it rather than let the throw escape.
    const id = name.slice(0, -5);
    let r: CanvasRecord | null;
    try {
      r = await readRecord(id);
    } catch {
      continue;
    }
    if (r === null) {
      // Either gone already, or unparseable. `list` is the sweep point --
      // no write is in flight here, so an unparseable file is genuine
      // corruption rather than a read that raced a write.
      const file = Bun.file(recordPath(id));
      if (await file.exists()) await deleteRecord(id).catch(() => {});
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
