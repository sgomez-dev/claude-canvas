import { mkdir, unlink, rename, readdir, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canvasesDir, recordPath } from "./paths";
import { assertIdent } from "./validate";
import type { OutcomeMessage } from "./protocol";
export { newToken } from "./token";

/**
 * How long a record that exists only to carry an unread outcome is kept,
 * measured from the moment the outcome was actually recorded (see
 * `outcomeAt` below) -- NOT from when the canvas started.
 *
 * The two used to be conflated (measured from `startedAt`), which meant a
 * canvas that stayed open longer than this window had its brand-new outcome
 * pruned by the very next `listRecords()` call, before any `wait` could ever
 * read it -- a canvas open over an hour is unusual but not rare (a document
 * left up for reference, a long-running form), and its outcome vanishing the
 * instant it was produced was a straightforward correctness bug, not a
 * marginal one.
 */
const OUTCOME_TTL_MS = 60 * 60 * 1000;

/**
 * A `.tmp` file younger than this is left alone by `listRecords`'s cleanup
 * sweep, on the assumption it may still be mid-write by a concurrent
 * `writeRecord`/`writeRecordSync` call in another process. Any real crash
 * leftover is trivially older than this by the time anyone calls `list`.
 */
const TMP_FILE_MIN_AGE_MS = 2000;

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
  /**
   * When `outcome` was actually recorded -- distinct from `startedAt`, and
   * what the TTL pruning in `listRecords` measures age from. See the
   * `OUTCOME_TTL_MS` comment for why the two must not be conflated.
   */
  outcomeAt?: string;
  /**
   * Set once a controller has read `outcome` live over the socket while the
   * canvas process was still alive (e.g. a canvas that intentionally stays
   * open a few seconds after answering, to show a confirmation). Distinct
   * from the record simply being deleted: deleting it here would make
   * `list`/`close` treat a still-visibly-open pane as gone, which is exactly
   * the "unclosable/untrackable pane" failure class this project's whole
   * lifecycle design exists to prevent. See consumeOutcome in client.ts.
   */
  outcomeConsumed?: boolean;
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
//
// A per-process temp name (`${path}.${pid}.tmp`) turned out not to be
// enough: two writes to the SAME id within the SAME process (a startup
// `writeRecord` racing an outcome-emitting `writeRecordSync` for the same
// id is a real sequence, not a hypothetical) can share that one temp path
// and collide. A monotonically increasing per-call counter, incremented
// synchronously before either write's first await, makes every write's temp
// path unique regardless of how the two interleave.
let tmpCounter = 0;
function tmpPath(path: string): string {
  tmpCounter += 1;
  return `${path}.${process.pid}.${tmpCounter}.tmp`;
}

/**
 * Renames `tmp` to `dest`, retrying on the transient Windows failure where
 * the destination is briefly held open by a concurrent reader.
 *
 * Measured directly from this project's own test suite: `%LOCALAPPDATA%\
 * claude-canvas\logs\<id>.log` showed `EPERM: operation not permitted,
 * rename ...tmp -> ...json` in 8 of 8 clean full-suite runs, for a test
 * whose only concurrent activity is `awaitRecord`'s repeated `readRecord`
 * polling -- this project's own reader, holding the file open for the
 * duration of one read. Windows disallows replacing a file that is
 * currently open without FILE_SHARE_DELETE, which Node's rename does not
 * request; the lock is held only for the instant of that one read, so a
 * short retry loop resolves it reliably without materially slowing down a
 * normal write.
 */
const RETRY_DELAYS_MS = [5, 10, 20, 30, 40, 40];

function isTransientRenameError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY";
}

async function renameWithRetry(tmp: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, dest);
      return;
    } catch (e) {
      if (!isTransientRenameError(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
      await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Synchronous sibling of renameWithRetry, for writeRecordSync -- which must
// stay synchronous (see its own doc comment), so the backoff is a blocking
// sleep via Atomics.wait rather than a Promise/setTimeout. Confirmed to
// actually block the calling thread (not just schedule a microtask) on this
// runtime; the retry budget below totals under 200 ms.
//
// Known limitation, confirmed by direct measurement: this can only ever
// resolve a lock held by a DIFFERENT OS process (the real production shape
// -- a canvas's own writeRecordSync racing a separate `cli.ts` invocation's
// read). If the concurrent reader is a pending Promise in this SAME
// process/thread (only possible in this project's in-process test harness,
// which simulates "a separate reader" with an ordinary async call in the
// same event loop), Atomics.wait blocking this thread also blocks that
// reader's own promise from ever settling -- so the lock it holds can never
// be released no matter how long or how many times this retries. Measured
// directly: a 10-attempt, ~1.7 s budget did not resolve that specific
// same-thread case, while an ordinary two-OS-process race (this function's
// real target) resolves within the very first one or two retries.
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(tmp: string, dest: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (e) {
      if (!isTransientRenameError(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
      sleepSyncMs(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export async function writeRecord(r: CanvasRecord): Promise<void> {
  assertIdent("id", r.id);
  // 0700: only this user can even traverse the directory, let alone read
  // the tokens inside it.
  await mkdir(canvasesDir(), { recursive: true, mode: 0o700 });
  const path = recordPath(r.id);
  const tmp = tmpPath(path);
  // Mode is passed to the OPEN call `writeFile` makes, not applied
  // afterward: the temp file carries a real auth token, and a write-then-
  // chmod sequence (the previous shape here) leaves a real, if brief, window
  // where that token sits on disk world-readable -- just at the temp path
  // instead of the final one, which is exactly the class of bug this is
  // supposed to close. `rename` preserves the source file's mode, so the
  // final path inherits 0600 too.
  await writeFile(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  await renameWithRetry(tmp, path);
}

/**
 * Synchronous sibling of writeRecord, for the one caller that needs it: a
 * canvas persisting its outcome. The component calls exit() as soon as the
 * outcome is sent, and process.exit does not wait for a pending async
 * write, so an awaited write here would lose the race it exists to win.
 */
export function writeRecordSync(r: CanvasRecord): void {
  assertIdent("id", r.id);
  mkdirSync(canvasesDir(), { recursive: true, mode: 0o700 });
  const path = recordPath(r.id);
  const tmp = tmpPath(path);
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameWithRetrySync(tmp, path);
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
  // Consumed by the controller that reads it (see consumeOutcome in
  // client.ts) -- deleted only once the canvas process has actually exited,
  // not merely because it was read.
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
    // something to report. But a temp file can also be genuinely mid-write
    // right now, from a concurrent writeRecord/writeRecordSync call in
    // another process -- deleting THAT out from under its writer is its own
    // bug, on the (previously unenforced) assumption that nothing is ever
    // mid-write when `listRecords` runs. Age-gate the cleanup instead: a
    // temp file younger than TMP_FILE_MIN_AGE_MS is left alone; any real
    // crash leftover is trivially older than that by the time `list` runs.
    if (name.endsWith(".tmp")) {
      const full = join(canvasesDir(), name);
      try {
        const info = await stat(full);
        if (Date.now() - info.mtimeMs < TMP_FILE_MIN_AGE_MS) continue;
      } catch {
        continue; // vanished between readdir and stat; nothing to clean up
      }
      await unlink(full).catch(() => {});
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
      // one would destroy an outcome a controller is about to read. Age is
      // measured from `outcomeAt` (when the outcome was actually recorded),
      // not `startedAt` (when the canvas started) -- see OUTCOME_TTL_MS.
      const recordedAt = r.outcomeAt ?? r.startedAt;
      const age = Date.now() - Date.parse(recordedAt);
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
 *
 * `after`, when given, rejects (keeps polling past) any record whose
 * `startedAt` predates it. Without this, a STALE record from a previous
 * invocation of the same default id (`spawn`'s id is deterministic per kind,
 * e.g. `picker-1`, reused across every invocation with no explicit `--id`)
 * is indistinguishable from the new invocation's own record: if invocation
 * 1's outcome was never consumed, its record is still sitting there the
 * instant invocation 2 starts polling, and invocation 2 would report
 * invocation 1's stale answer as its own -- reproduced directly, returned in
 * under 1 ms. Passing `after: Date.now()` captured before invocation 2 does
 * anything closes that window: only a record genuinely written by THIS
 * invocation can satisfy the wait.
 */
export async function awaitRecord(
  id: string,
  timeoutMs: number,
  opts?: { after?: number }
): Promise<CanvasRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await readRecord(id);
    if (r && (opts?.after === undefined || Date.parse(r.startedAt) >= opts.after)) return r;
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
