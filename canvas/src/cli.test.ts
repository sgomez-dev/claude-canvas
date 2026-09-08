import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { emit, resolveWaitTimeout, listCanvases, runShow, runSpawn, type ActionIO } from "./cli";
import { writeRecord, deleteRecord, newToken } from "./runtime/registry";
import { configPath } from "./runtime/paths";

// A fake ActionIO that records what would have gone to stdout and what exit
// code would have been used, instead of ever calling the real process.exit
// (which would tear down the test runner) or writing to the real stdout.
function captureIO(): { io: ActionIO; lines: string[]; exits: number[] } {
  const lines: string[] = [];
  const exits: number[] = [];
  return {
    io: {
      write: (s: string) => { lines.push(s); return true; },
      exit: (code: number) => { exits.push(code); },
    },
    lines,
    exits,
  };
}

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

// Regression coverage for a review finding on this task: nothing previously
// asserted that assertIdent is actually wired into the show/spawn action
// bodies (as opposed to just existing as a helper elsewhere). These call the
// real .action() logic via the runShow/runSpawn exports, not just a
// standalone validator.
test("show rejects an invalid kind and still exits 0 (never a non-zero exit on a pane)", async () => {
  const { io, lines, exits } = captureIO();
  // A valid --id is supplied so the kind check (which runs second) is the
  // one that actually fires, rather than the default `${kind}-1` id
  // inheriting the same bad characters and failing first.
  await runShow("bad kind!", { id: "cli-test-show-badkind" }, io);
  expect(exits).toEqual([0]);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.status).toBe("error");
  expect(parsed.message).toContain("Invalid kind");
});

// Critical finding from the final whole-branch review: assertIdent only
// validates identifier *shape*, not membership in the set of implemented
// canvas kinds. A typo like "documnet" used to sail past assertIdent and
// reach renderCanvas's switch, whose default branch called process.exit(1)
// from inside what can be a spawned pane — since process.exit doesn't
// unwind, the pane's own exit-0 handling never ran, leaving an unremovable
// pane on Windows. Both runShow and runSpawn must reject an unknown kind
// before ever reaching the pane-spawning/rendering code.
test("show rejects an unknown (but shape-valid) kind and still exits 0", async () => {
  const { io, lines, exits } = captureIO();
  await runShow("documnet", { id: "cli-test-show-unknownkind" }, io);
  expect(exits).toEqual([0]);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.status).toBe("error");
  expect(parsed.message).toContain("Unknown canvas kind");
});

test("spawn rejects an unknown (but shape-valid) kind with exit 1, before ever calling the host", async () => {
  const { io, lines, exits } = captureIO();
  await runSpawn("documnet", { id: "cli-test-spawn-unknownkind" }, io);
  expect(exits).toEqual([1]);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.status).toBe("error");
  // If the kind check didn't run first, this would instead fail with
  // "No canvas host available..." (from detectHost()) in a CI environment
  // with no tmux/Windows Terminal — proof the host is never reached.
  expect(parsed.message).toContain("Unknown canvas kind");
});

test("show rejects an invalid --scenario and still exits 0", async () => {
  const { io, lines, exits } = captureIO();
  await runShow("document", { id: "cli-test-show-badscenario", scenario: "bad scenario!" }, io);
  expect(exits).toEqual([0]);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.status).toBe("error");
  expect(parsed.message).toContain("Invalid scenario");
});

test("spawn rejects an invalid --id with exit 1 and an error status", async () => {
  const { io, lines, exits } = captureIO();
  await runSpawn("document", { id: "bad id!" }, io);
  expect(exits).toEqual([1]);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.status).toBe("error");
  expect(parsed.message).toContain("Invalid id");
});

// Review finding: spawn used to write opts.config straight to configPath(id)
// with no JSON.parse sanity check, then report {"status":"spawned"} even
// though `show` would later crash trying to parse it back. Assert both that
// spawn now reports the failure (exit 1, status "error") and, critically,
// that it never wrote the bad config to disk first.
test("spawn rejects malformed --config JSON before ever writing configPath, with exit 1", async () => {
  const { io, lines, exits } = captureIO();
  const id = "cli-test-spawn-badconfig";
  try {
    await runSpawn("document", { id, config: "{not valid json" }, io);
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("Invalid --config");
    expect(await Bun.file(configPath(id)).exists()).toBe(false);
  } finally {
    // Belt-and-braces: the assertion above already fails loudly if this file
    // exists, but clean it up regardless in case a future regression writes it.
    try {
      await unlink(configPath(id));
    } catch {
      // already absent, which is the expected/passing case
    }
  }
});
