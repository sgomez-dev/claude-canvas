import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit, resolveWaitTimeout, listCanvases } from "./cli";
import { writeRecord, deleteRecord, newToken } from "./runtime/registry";

test("emit prints exactly one JSON object", () => {
  const lines: string[] = [];
  const write = (s: string) => { lines.push(s); return true; };
  emit({ status: "pending" }, write as never);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "")).toEqual({ status: "pending" });
});

test("wait timeout defaults below the Bash tool's 120s limit", () => {
  expect(resolveWaitTimeout(undefined)).toBe(55_000);
  expect(resolveWaitTimeout("10")).toBe(10_000);
});

test("wait timeout rejects nonsense", () => {
  expect(() => resolveWaitTimeout("abc")).toThrow();
  expect(() => resolveWaitTimeout("-5")).toThrow();
});

// Task 5's review flagged listRecords against a not-yet-created canvases
// directory as untested, despite being the literal first-run path for
// `canvas list`. Point LOCALAPPDATA (this suite runs on win32) at a
// directory that has never been created — nothing writes to it, and
// nothing else on the machine shares this random name — so canvasesDir()
// resolves to a real ENOENT rather than one that happens to already exist.
test("list returns an empty array, not a throw, when the canvases dir was never created", async () => {
  const original = process.env.LOCALAPPDATA;
  const fresh = join(tmpdir(), `claude-canvas-fresh-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.LOCALAPPDATA = fresh;
  try {
    expect(await listCanvases()).toEqual({ status: "ok", canvases: [] });
  } finally {
    if (original === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = original;
  }
});

// Complements the fresh-registry test above: confirms listCanvases forwards
// whatever the registry actually holds, so an empty result isn't just a
// hardcoded stub.
test("list forwards live records from the registry", async () => {
  const id = "cli-test-list-live";
  await writeRecord({
    id, kind: "document", scenario: "display", port: 1234, token: newToken(),
    pid: process.pid, startedAt: new Date().toISOString(), host: "test",
  });
  try {
    const result = await listCanvases();
    expect(result.status).toBe("ok");
    expect(result.canvases.map((c) => c.id)).toContain(id);
  } finally {
    await deleteRecord(id);
  }
});
