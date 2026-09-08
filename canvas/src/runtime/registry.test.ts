import { test, expect, afterEach } from "bun:test";
import {
  writeRecord,
  writeRecordSync,
  readRecord,
  listRecords,
  deleteRecord,
  newToken,
  isAlive,
  type CanvasRecord,
} from "./registry";
import { canvasesDir, recordPath } from "./paths";
import { mkdir, readdir } from "node:fs/promises";
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
  const stray = join(canvasesDir(), `reg-stray.json.${process.pid}.tmp`);
  await Bun.write(stray, "{}");

  await listRecords();
  expect(await Bun.file(stray).exists()).toBe(false);
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
