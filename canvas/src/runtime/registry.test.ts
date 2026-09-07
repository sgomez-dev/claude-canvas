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
