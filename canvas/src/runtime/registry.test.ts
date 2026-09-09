import { test, expect, afterEach } from "bun:test";
import {
  writeRecord,
  writeRecordSync,
  readRecord,
  listRecords,
  deleteRecord,
  awaitRecord,
  newToken,
  isAlive,
  type CanvasRecord,
} from "./registry";
import { canvasesDir, recordPath } from "./paths";
import { mkdir, readdir, utimes, unlink } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { InvalidIdentifierError } from "./validate";

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

test("a lastError record survives with a dead pid and is not unlinked", async () => {
  // pid 0x7FFFFFFE will not exist on any platform in practice.
  await writeRecord(rec("t-err-dead", { pid: 0x7ffffffe, lastError: "bind failed" }));
  expect(await readRecord("t-err-dead")).toEqual(expect.objectContaining({ lastError: "bind failed" }));
  expect(await Bun.file((await import("./paths")).recordPath("t-err-dead")).exists()).toBe(true);
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
  await expect(readRecord("../escape")).rejects.toThrow(InvalidIdentifierError);
});

// Records are written to a temp file and renamed into place. Neither
// Bun.write nor writeFileSync is atomic, and readRecord used to DELETE
// anything that failed to parse -- so a read that raced a write destroyed a
// good record and nothing rewrote it. That failed on windows-latest only
// (CI run 34276286536): awaitRecord polled for 5 s for a record its own
// first read had already unlinked.
test("an unparseable record is not destroyed by reading it", async () => {
  const id = "reg-corrupt";
  ids.push(id);
  await mkdir(canvasesDir(), { recursive: true });
  await Bun.write(recordPath(id), "{ this is not json");

  expect(await readRecord(id)).toBeNull();
  // Still there: reading is not the place to destroy state.
  expect(await Bun.file(recordPath(id)).exists()).toBe(true);
});

test("listRecords prunes an unparseable record, since nothing is mid-write there", async () => {
  const id = "reg-corrupt-2";
  ids.push(id);
  await mkdir(canvasesDir(), { recursive: true });
  await Bun.write(recordPath(id), "{ this is not json");

  await listRecords();
  expect(await Bun.file(recordPath(id)).exists()).toBe(false);
});

test("listRecords cleans up a temp file left by a crashed write", async () => {
  await mkdir(canvasesDir(), { recursive: true });
  const stray = join(canvasesDir(), `reg-stray.json.${process.pid}.0.tmp`);
  await Bun.write(stray, "{}");
  // Backdate the mtime well past TMP_FILE_MIN_AGE_MS: this test exercises
  // genuine crash cleanup, not the young-file skip added for Fix 6 (see the
  // test right below), and a brand-new file would otherwise be left alone.
  const old = new Date(Date.now() - 10_000);
  await utimes(stray, old, old);

  await listRecords();
  expect(await Bun.file(stray).exists()).toBe(false);
});

// Fix 6: listRecords used to delete ANY .tmp file unconditionally, on the
// (unenforced) assumption that nothing is ever mid-write when it runs. A
// temp file can genuinely be mid-write from a concurrent writeRecord /
// writeRecordSync call in another process at exactly that moment -- deleting
// it out from under its own writer would turn that write into a silent
// failure (the rename at the end would then find its source gone).
test("listRecords does not delete a temp file that might still be mid-write", async () => {
  await mkdir(canvasesDir(), { recursive: true });
  const fresh = join(canvasesDir(), `reg-inflight.json.${process.pid}.0.tmp`);
  await Bun.write(fresh, "{}");
  try {
    await listRecords();
    expect(await Bun.file(fresh).exists()).toBe(true);
  } finally {
    await unlink(fresh).catch(() => {});
  }
});

// Fix 6: two writes to the SAME id, concurrently, within the same process --
// a startup writeRecord racing an outcome-emitting writeRecordSync for the
// same id is a real sequence, not a hypothetical. A per-process (rather than
// per-write) temp path let these two collide.
test("concurrent writes to the same id do not collide on their temp path", async () => {
  const id = "reg-same-id-race";
  ids.push(id);
  const base = rec(id);
  await Promise.all([
    writeRecord({ ...base, port: 1 }),
    writeRecord({ ...base, port: 2 }),
    writeRecord({ ...base, port: 3 }),
    writeRecord({ ...base, port: 4 }),
  ]);
  // Whichever write landed last, the record on disk must be one writer's
  // complete output, never a mix of two -- and readable at all, which a
  // temp-path collision (one writer's rename finding its source already
  // consumed by another) would put at risk.
  const r = await readRecord(id);
  expect(r).not.toBeNull();
  expect(r!.token).toBe(base.token);
  expect([1, 2, 3, 4]).toContain(r!.port);
  const names = await readdir(canvasesDir());
  expect(names.filter((n) => n.includes(id) && n.endsWith(".tmp"))).toEqual([]);
});

test("a record is never observable half-written", async () => {
  const id = "reg-atomic";
  ids.push(id);
  const base: CanvasRecord = {
    id, kind: "document", scenario: "display", port: 1, token: newToken(),
    pid: process.pid, startedAt: new Date().toISOString(), host: "test",
  };
  await writeRecord(base);

  // Interleave rewrites with reads. Every read must see a complete record:
  // with an in-place write, one of these can catch a truncated file, and
  // with the old readRecord that also deleted it.
  for (let i = 0; i < 60; i++) {
    writeRecordSync({ ...base, port: 1000 + i });
    const r = await readRecord(id);
    expect(r).not.toBeNull();
    expect(r!.token).toBe(base.token);
  }
  // And no temp file is left behind.
  const names = await readdir(canvasesDir());
  expect(names.filter((n) => n.includes(id) && n.endsWith(".tmp"))).toEqual([]);
});

// Fix 1 (CRITICAL). Windows disallows replacing a file that a concurrent
// reader currently has open (without FILE_SHARE_DELETE), which Node's
// rename() does not request -- and this project's own `awaitRecord` polls
// via repeated reads, so it is itself that reader. Measured directly from
// this suite's own log output before this fix: `rename ...tmp -> ...json`
// failed with EPERM in 8 of 8 clean runs for a test whose only concurrent
// activity was that polling. Reproduced deterministically here (rather than
// relying on timing luck) by holding an explicit read handle open on the
// destination path -- the same lock a `readRecord`/`Bun.file` read holds for
// the duration of its own read -- across a write, and releasing it partway
// through the retry budget.
test("writeRecord survives a transient EPERM from a concurrent reader (Fix 1)", async () => {
  const id = "reg-eperm-async";
  ids.push(id);
  await writeRecord(rec(id, { port: 1 }));
  const path = recordPath(id);
  const fd = openSync(path, "r");
  const releaseAt = Date.now();
  setTimeout(() => closeSync(fd), 20);
  await writeRecord(rec(id, { port: 2 }));
  expect(Date.now()).toBeGreaterThanOrEqual(releaseAt); // sanity: time actually passed
  expect((await readRecord(id))?.port).toBe(2);
});

test("writeRecordSync survives a transient EPERM from a concurrent reader (Fix 1)", async () => {
  const id = "reg-eperm-sync";
  ids.push(id);
  writeRecordSync(rec(id, { port: 1 }));
  const path = recordPath(id);
  // writeRecordSync's retry backoff blocks via Atomics.wait -- the whole JS
  // thread, including the event loop -- so a same-process setTimeout
  // releasing the lock (as the async test above uses) would never fire
  // while writeRecordSync itself is blocked waiting for it. Use a genuinely
  // separate OS process to hold the read lock instead: it keeps running
  // regardless of whatever our own thread is blocked doing, exactly like
  // this project's real awaitRecord polling (a concurrent reader in a
  // different call) is a different execution context from the writer.
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `const fs=require("node:fs");const fd=fs.openSync(${JSON.stringify(path)},"r");` +
        `const s=Date.now();while(Date.now()-s<30){}fs.closeSync(fd);`,
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await new Promise((res) => setTimeout(res, 10)); // let the holder actually open it first
    // writeRecordSync is genuinely synchronous (see its own doc comment), so
    // this call blocks for however long its internal retry backoff takes --
    // there is nothing to await.
    writeRecordSync(rec(id, { port: 2 }));
    expect((await readRecord(id))?.port).toBe(2);
  } finally {
    await holder.exited;
  }
});

// Fix 2 (CRITICAL). spawn's default id is deterministic per kind and reused
// across invocations. Without a cutoff, a stale, unconsumed outcome left by
// a PREVIOUS invocation is indistinguishable from a NEW invocation's own
// record -- awaitRecord would return it on the very first poll, before the
// new canvas has even started. `after` closes that window.
test("awaitRecord rejects a stale record that predates the given cutoff", async () => {
  const id = "reg-stale-spawn";
  ids.push(id);
  // Simulates invocation 1: an unconsumed outcome, already sitting in the
  // registry before invocation 2 ("this spawn") begins.
  await writeRecord(rec(id, { outcome: { type: "selected", data: { from: "spawn-1" } } }));

  const after = Date.now() + 25; // invocation 2's cutoff, captured "at spawn start"
  const result = await awaitRecord(id, 200, { after });
  // No record written AFTER the cutoff ever appears, so this must time out
  // -- not return spawn 1's stale answer, which the unfixed code did in
  // under 1 ms.
  expect(result).toBeNull();
});

test("awaitRecord accepts a record written at or after the given cutoff", async () => {
  const id = "reg-fresh-spawn";
  ids.push(id);
  const after = Date.now();
  await new Promise((res) => setTimeout(res, 10));
  await writeRecord(rec(id)); // rec()'s startedAt is "now", i.e. after `after`
  const result = await awaitRecord(id, 500, { after });
  expect(result?.id).toBe(id);
});

test("awaitRecord with no `after` behaves exactly as before (back-compat)", async () => {
  const id = "reg-no-cutoff";
  ids.push(id);
  await writeRecord(rec(id));
  expect((await awaitRecord(id, 500))?.id).toBe(id);
});

// Fix 3. TTL pruning in listRecords must measure an outcome's age from when
// it was RECORDED (`outcomeAt`), not from when the canvas STARTED
// (`startedAt`). A canvas open longer than the TTL (an hour) would
// otherwise have its brand-new outcome pruned by the very next
// `listRecords()` call, before any `wait` could read it.
test("an outcome from a long-lived canvas is not pruned just because startedAt is old", async () => {
  const id = "reg-ttl-longlived";
  ids.push(id);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await writeRecord(
    rec(id, {
      pid: 0x7ffffffe, // dead, so it's eligible for TTL pruning at all
      startedAt: twoHoursAgo, // canvas has been "open" for two hours
      outcome: { type: "selected", data: { x: 1 } },
      outcomeAt: new Date().toISOString(), // but only just answered
    })
  );
  await listRecords();
  // Still there: the outcome is fresh, even though the canvas is not.
  expect((await readRecord(id))?.outcome).toEqual({ type: "selected", data: { x: 1 } });
});

test("an outcome older than the TTL, measured from outcomeAt, is pruned", async () => {
  const id = "reg-ttl-expired";
  ids.push(id);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await writeRecord(
    rec(id, {
      pid: 0x7ffffffe,
      startedAt: twoHoursAgo,
      outcome: { type: "selected", data: { x: 1 } },
      outcomeAt: twoHoursAgo, // answered long ago too, and never consumed
    })
  );
  await listRecords();
  expect(await readRecord(id)).toBeNull();
});

// Fix 8. The token is real secret material that must never be
// world-readable on disk, even briefly. `chmod` after the fact (the
// previous shape) just moves that window from the final path to the temp
// path; the mode has to be applied at file-creation time instead. File
// permission bits are not meaningfully enforced on Windows, so this is
// skipped there -- the code change is still correct to make, just not
// independently verifiable on this platform.
test.skipIf(process.platform === "win32")(
  "the record file and its directory are created with restrictive permissions (Fix 8)",
  async () => {
    const id = "reg-perms";
    ids.push(id);
    await writeRecord(rec(id));
    const { stat } = await import("node:fs/promises");
    const fileMode = (await stat(recordPath(id))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = (await stat(canvasesDir())).mode & 0o777;
    expect(dirMode).toBe(0o700);
  }
);
