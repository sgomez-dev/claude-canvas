import { test, expect, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import * as terminalProbeReal from "./host/terminal-probe";
import * as hostReal from "./host";
import type { ProbeSource, ProcessRow } from "./host/terminal-probe";

// Captured as PLAIN locals, not read back through the namespace imports
// inside a restore factory: both are live bindings, so once a test below
// has mocked either module, reading `terminalProbeReal.systemProbe` or
// `hostReal.detectHost` again would resolve to the FAKE just installed --
// restoring with `{...terminalProbeReal}`/`{...hostReal}` alone would
// silently reinstall the fake forever, leaking it into every test file that
// runs after this one in the same process. Captured once, before any test
// in this file mocks anything, so each always names the true original. Same
// technique, same reason, as `originalDecodePng` in
// test/integration/image.test.tsx.
const realSystemProbe = terminalProbeReal.systemProbe;
const realDetectHost = hostReal.detectHost;
import {
  emit,
  resolveWaitTimeout,
  listCanvases,
  runShow,
  runSpawn,
  resolveScenario,
  resolveUpdateConfig,
  buildShowArgv,
  KIND_DEFAULT_SCENARIO,
  type ActionIO,
} from "./cli";
import { getScenario, listScenarios } from "./scenarios/registry";
import { writeRecord, readRecord, deleteRecord, newToken } from "./runtime/registry";
import { configPath } from "./runtime/paths";
import { startCanvasServer } from "./runtime/server";
import { getValue } from "./runtime/client";

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
// `canvas list`. dataDir() only consults LOCALAPPDATA on win32 (darwin uses
// Library/Application Support, linux uses XDG_STATE_HOME/.local/state), so
// setting LOCALAPPDATA alone only exercises this path when the test runner
// itself happens to be on Windows — on darwin/linux it would silently check
// the real (possibly non-empty) canvases dir instead, asserting nothing
// meaningful. Force process.platform to "win32" for the duration of this
// test (same capture/restore pattern as runtime/paths.test.ts) so it
// resolves to a real ENOENT — and exercises the empty-directory path — on
// every OS, not just when the runner happens to be Windows.
test("list returns an empty array, not a throw, when the canvases dir was never created", async () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const original = process.env.LOCALAPPDATA;
  const fresh = join(tmpdir(), `claude-canvas-fresh-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.LOCALAPPDATA = fresh;
    expect(await listCanvases()).toEqual({ status: "ok", canvases: [] });
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
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

// --- reuse detection (Phase 2) --------------------------------------------
//
// Documented as deferred since Phase 1 (2026-09-07-canvas-foundations-design.md,
// "Reuse detection is NOT implemented in Phase 1"): spawning twice with the
// same --id used to silently overwrite the first canvas's registry record
// with the second's, even though the first pane was still open and its
// process still alive -- orphaning it, unreachable via wait/get/close, for
// the rest of its process lifetime. Reproduced directly (outside this suite)
// by writing a record, writing a second one for the same id, and observing
// the first record's port/token vanish from the registry while its pid was
// still alive throughout.
//
// These tests exercise the fix at the level of the actual `runSpawn`
// export, the same function real `spawn` invocations call, using a real
// `startCanvasServer` + `writeRecord` to stand in for "a canvas is already
// running" -- the same technique runtime/integration.test.ts uses for a real
// live canvas without needing an actual terminal host (this suite runs in
// CI, on all three OSes, none of which have tmux or Windows Terminal
// available). The refusal must happen before `detectHost()`/`host.open()`
// are ever reached, so this is deterministic regardless of what host (if
// any) the machine running the test happens to have.

test("spawn refuses to reuse --id when a live canvas already holds it, and leaves its record untouched", async () => {
  const id = "cli-test-spawn-reuse-live";
  // Cleared for the same reason as the two tests below: the refusal must
  // fire before detectHost()/host.open() are ever reached, so clearing
  // these guarantees this test never depends on -- or accidentally drives --
  // whatever real terminal host (if any) happens to be available on the
  // machine running it.
  const savedWt = process.env.WT_SESSION;
  const savedTmux = process.env.TMUX;
  delete process.env.WT_SESSION;
  delete process.env.TMUX;
  const server = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: "still-here" });
    },
  });
  try {
    const original = {
      id, kind: "document", scenario: "display",
      port: server.port, token: server.token, pid: process.pid,
      startedAt: new Date().toISOString(), host: "test",
    };
    await writeRecord(original);

    const { io, lines, exits } = captureIO();
    await runSpawn("document", { id }, io);

    // Refused, not a silent success.
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain(id);
    expect(parsed.message).toContain("already running");
    expect(parsed.message).toContain(String(process.pid));

    // The original record must be completely untouched: same port, same
    // token, same pid -- still the exact canvas that was already running,
    // not silently replaced.
    const stillThere = await readRecord(id);
    expect(stillThere).toEqual(original);

    // And still genuinely reachable over IPC, exactly as before the refused
    // spawn attempt -- not just a registry file that happens to look right.
    expect(await getValue(id, "anything")).toBe("still-here");
  } finally {
    await deleteRecord(id);
    server.stop();
    if (savedWt === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = savedWt;
    if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
  }
});

test("spawn proceeds normally (past the liveness check) when no record exists for --id", async () => {
  // Force detectHost() to fail deterministically regardless of what host
  // the machine running this test happens to have available (this sandbox,
  // for instance, has WT_SESSION set) -- the point of this test is only that
  // execution gets PAST the new liveness check, not that a real pane opens.
  const savedWt = process.env.WT_SESSION;
  const savedTmux = process.env.TMUX;
  delete process.env.WT_SESSION;
  delete process.env.TMUX;
  try {
    const { io, lines, exits } = captureIO();
    await runSpawn("document", { id: "cli-test-spawn-reuse-absent" }, io);
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.status).toBe("error");
    // Reaches detectHost()'s own error, not the "already running" refusal --
    // proof the absent-record case was never blocked by the new check.
    expect(parsed.message).toContain("No canvas host available");
    expect(parsed.message).not.toContain("already running");
  } finally {
    if (savedWt === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = savedWt;
    if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
  }
});

test("spawn proceeds normally (past the liveness check) when the existing record's process is dead", async () => {
  const id = "cli-test-spawn-reuse-dead";
  // pid 0x7FFFFFFE will not exist on any platform in practice -- the same
  // convention runtime/registry.test.ts uses for a dead-process record.
  await writeRecord({
    id, kind: "document", scenario: "display", port: 1234, token: newToken(),
    pid: 0x7ffffffe, startedAt: new Date().toISOString(), host: "test",
  });
  const savedWt = process.env.WT_SESSION;
  const savedTmux = process.env.TMUX;
  delete process.env.WT_SESSION;
  delete process.env.TMUX;
  try {
    const { io, lines, exits } = captureIO();
    await runSpawn("document", { id }, io);
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("No canvas host available");
    expect(parsed.message).not.toContain("already running");
  } finally {
    if (savedWt === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = savedWt;
    if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
    await deleteRecord(id);
  }
});

// --- scenario resolution -------------------------------------------------

// Every kind used to default to "display". So `spawn flight` ran with
// scenario "display" -- not a scenario flight has -- and only worked
// because flight.tsx ignores the string; the registry record then recorded
// a scenario that does not exist.
test("each kind defaults to a scenario it actually has, not to display", () => {
  for (const [kind, expected] of KIND_DEFAULT_SCENARIO) {
    expect(resolveScenario(kind, undefined)).toBe(expected);
  }
});

// The invariant that keeps the CLI's defaults and the registry from
// drifting apart, which is exactly how flight ended up defaulting to a
// nonexistent scenario.
test("every kind's default scenario is registered, and every registered kind is known", () => {
  for (const [kind, scenario] of KIND_DEFAULT_SCENARIO) {
    expect(getScenario(kind, scenario)).toBeDefined();
  }
  for (const s of listScenarios()) {
    expect(KIND_DEFAULT_SCENARIO.has(s.canvasKind)).toBe(true);
  }
});

test("a shape-valid but nonexistent scenario is rejected, naming the real ones", () => {
  expect(() => resolveScenario("calendar", "meting-picker")).toThrow(
    /Unknown scenario for calendar: meting-picker.*display, meeting-picker/
  );
  expect(() => resolveScenario("flight", "display")).toThrow(/Expected one of: booking/);
});

test("an explicitly requested valid scenario is returned unchanged", () => {
  expect(resolveScenario("calendar", "meeting-picker")).toBe("meeting-picker");
  expect(resolveScenario("document", "email-preview")).toBe("email-preview");
});

test("scenario shape is still validated before the registry is consulted", () => {
  expect(() => resolveScenario("calendar", "bad scenario!")).toThrow(/Invalid scenario/);
});

// resolveScenario's own precondition, not just its callers': both current
// call sites (`runShow`/`runSpawn`) already call assertKnownKind first, but
// resolveScenario didn't enforce that itself -- calling it directly with an
// unknown kind (as this test does) used to fall through to a confusing
// "Invalid scenario" error instead of naming the real problem.
test("an unknown kind is rejected by name, not as a confusing scenario error", () => {
  expect(() => resolveScenario("bogus-kind", undefined)).toThrow(/Unknown canvas kind: bogus-kind/);
  expect(() => resolveScenario("bogus-kind", "display")).toThrow(/Unknown canvas kind: bogus-kind/);
});

test("spawn rejects an unknown scenario with exit 1, before ever calling the host", async () => {
  const { io, lines, exits } = captureIO();
  await runSpawn("calendar", { id: "cli-test-badscenario", scenario: "nope" }, io);
  expect(exits).toEqual([1]);
  expect(JSON.parse(lines[0]!).status).toBe("error");
  expect(JSON.parse(lines[0]!).message).toContain("Unknown scenario for calendar");
});

test("show rejects an unknown scenario and still exits 0 (never a non-zero exit on a pane)", async () => {
  const { io, lines, exits } = captureIO();
  await runShow("calendar", { id: "cli-test-badscenario2", scenario: "nope" }, io);
  expect(exits).toEqual([0]);
  expect(JSON.parse(lines[0]!).status).toBe("error");
});

// --- update ---------------------------------------------------------------

test("update needs exactly one of --config or --config-file", async () => {
  await expect(resolveUpdateConfig({})).rejects.toThrow(/exactly one/);
  await expect(
    resolveUpdateConfig({ config: "{}", configFile: "/tmp/x.json" })
  ).rejects.toThrow(/exactly one/);
});

test("update rejects malformed --config JSON rather than pushing garbage", async () => {
  await expect(resolveUpdateConfig({ config: "{not json" })).rejects.toThrow(/not valid JSON/);
});

test("update parses --config into the object it will push", async () => {
  expect(await resolveUpdateConfig({ config: '{"rows":[{"a":"1"}]}' })).toEqual({
    rows: [{ a: "1" }],
  });
});

// --- graphics tier propagation -------------------------------------------

// Measured 2026-09-09: inside tmux, TERM_PROGRAM becomes "tmux" and TERM
// becomes "tmux-256color", so a canvas in a pane cannot see what terminal it
// is drawing to at all. The controller runs in the user's shell where the
// real values survive, so it detects the tier and passes it down. Without
// that, every spawned canvas would be stuck on the baseline tier no matter
// what the terminal could do.
test("spawn's argv carries the graphics tier down to the pane", () => {
  const argv = buildShowArgv("picker", "p1", "select", "kitty");
  const i = argv.indexOf("--graphics");
  expect(i).toBeGreaterThan(-1);
  expect(argv[i + 1]!).toBe("kitty");
});

// The bundle exposed this one: `${import.meta.dir}/cli.ts` is a hardcoded
// filename, and the shipped plugin runs dist/cli.js, so the pane opened and
// the canvas inside it died instantly on a path that did not exist.
test("spawn's argv runs whichever entry point is executing, not a guessed sibling", async () => {
  const argv = buildShowArgv("picker", "p1", "select", "halfblocks");
  const entry = argv[2]!;
  // Asserting equality with this test file's own `import.meta.path` would
  // be wrong -- the value comes from cli.ts's module scope, not here. What
  // matters is that it names a file that actually EXISTS and is the CLI:
  // the bug was a hardcoded `${import.meta.dir}/cli.ts`, which from the
  // shipped dist/cli.js bundle pointed at a sibling that does not exist, so
  // the pane opened and the canvas died instantly.
  expect(await Bun.file(entry).exists()).toBe(true);
  expect(await Bun.file(entry).text()).toContain("buildShowArgv");
});

test("spawn's argv appends the config file only when there is one", () => {
  expect(buildShowArgv("table", "t1", "display", "sixel")).not.toContain("--config-file");
  const withCfg = buildShowArgv("table", "t1", "display", "sixel", "/tmp/x.json");
  const i = withCfg.indexOf("--config-file");
  expect(i).toBeGreaterThan(-1);
  expect(withCfg[i + 1]!).toBe("/tmp/x.json");
});

// The receiving half. `show` writes the tier into its own environment rather
// than threading it as a prop, so baseCapabilities, the `ready` message's
// capabilities and the eventual image renderer all resolve the same value
// with no further plumbing.
test("show writes the passed tier into its own environment", async () => {
  const before = process.env.CANVAS_GRAPHICS;
  const { io } = captureIO();
  try {
    delete process.env.CANVAS_GRAPHICS;
    // A config file that does not exist makes runShow fail AFTER it has set
    // the environment, which is what this asserts on.
    await runShow(
      "picker",
      { id: "cli-graphics-1", scenario: "select", configFile: "/nonexistent.json", graphics: "kitty" },
      io
    );
    expect(process.env.CANVAS_GRAPHICS!).toBe("kitty");
  } finally {
    if (before === undefined) delete process.env.CANVAS_GRAPHICS;
    else process.env.CANVAS_GRAPHICS = before;
  }
});

test("show rejects a misspelled --graphics rather than silently painting blocks", async () => {
  const before = process.env.CANVAS_GRAPHICS;
  const { io, lines, exits } = captureIO();
  try {
    delete process.env.CANVAS_GRAPHICS;
    await runShow("picker", { id: "cli-graphics-2", scenario: "select", graphics: "sixl" }, io);
    // Still exits 0: a non-zero exit from inside a pane leaves an
    // unremovable one on Windows, which is why runShow's finally clause
    // exists at all.
    expect(exits).toEqual([0]);
    expect(JSON.parse(lines[0]!).message).toMatch(/Invalid --graphics: "sixl"/);
  } finally {
    if (before === undefined) delete process.env.CANVAS_GRAPHICS;
    else process.env.CANVAS_GRAPHICS = before;
  }
});

// --- systemProbe wiring (Task review, 2026-09-11) -------------------------
//
// Sabotage-confirmed gap: dropping `systemProbe` from either runShow's or
// runSpawn's `resolveGraphics(process.env, ..., systemProbe)` call left the
// whole suite (610 tests at the time) green. Every existing test either
// pins CANVAS_GRAPHICS (which short-circuits before any probe is
// consulted) or leaves TMUX unset (which skips the probe branch regardless
// of whether it was wired in) -- so nothing actually exercised the real
// production call sites, only resolveGraphics called directly with a probe
// argument the test itself supplied. These two tests mock the REAL
// systemProbe cli.ts imports, then call runShow/runSpawn exactly as `show`/
// `spawn` do, so a passing result is proof the wiring survives, not proof
// resolveGraphics works (graphics.test.ts already covers that).

const WEZTERM_TREE: ProcessRow[] = [
  { pid: 72795, ppid: 72794, command: "-zsh" },
  { pid: 73178, ppid: 72795, command: "tmux" },
  { pid: 72794, ppid: 1, command: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
];

const fakeProbe: ProbeSource = {
  clientTty: () => "/dev/ttys017",
  processes: () => WEZTERM_TREE,
  pidsOnTty: () => [72795, 73178],
};

test("show resolves the probed tier when inside tmux with no override, not just the plain-environment guess", async () => {
  const saved = {
    graphics: process.env.CANVAS_GRAPHICS,
    tmux: process.env.TMUX,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
  };
  mock.module("./host/terminal-probe", () => ({
    ...terminalProbeReal,
    systemProbe: fakeProbe,
  }));
  try {
    delete process.env.CANVAS_GRAPHICS;
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    process.env.TERM = "xterm-256color";
    delete process.env.TERM_PROGRAM;

    const { io } = captureIO();
    // A config file that does not exist makes runShow fail AFTER it has
    // set CANVAS_GRAPHICS -- the same technique "show writes the passed
    // tier into its own environment" above uses -- which is what this
    // asserts on. Without the probe wired in, plain detectGraphics(process.env)
    // would land on "quadrants" here (no TERM_PROGRAM, no other markers), a
    // different tier from the mocked WezTerm tree's "sixel", making the two
    // cases unmistakable.
    await runShow(
      "picker",
      { id: "cli-graphics-probe", scenario: "select", configFile: "/nonexistent.json" },
      io
    );
    expect(process.env.CANVAS_GRAPHICS!).toBe("sixel");
  } finally {
    mock.module("./host/terminal-probe", () => ({
      ...terminalProbeReal,
      systemProbe: realSystemProbe,
    }));
    if (saved.graphics === undefined) delete process.env.CANVAS_GRAPHICS;
    else process.env.CANVAS_GRAPHICS = saved.graphics;
    if (saved.tmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = saved.tmux;
    if (saved.term === undefined) delete process.env.TERM;
    else process.env.TERM = saved.term;
    if (saved.termProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.termProgram;
  }
});

test("spawn resolves the probed tier when inside tmux with no override, and passes it in the spawned process's argv", async () => {
  const id = "cli-test-spawn-probe";
  const saved = {
    graphics: process.env.CANVAS_GRAPHICS,
    tmux: process.env.TMUX,
    wt: process.env.WT_SESSION,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
  };
  let capturedArgv: string[] | undefined;
  mock.module("./host/terminal-probe", () => ({
    ...terminalProbeReal,
    systemProbe: fakeProbe,
  }));
  // detectHost()/host.open() are replaced with a fake that never spawns a
  // real pane (this suite runs in CI on all three OSes, none of which are
  // guaranteed to have tmux or Windows Terminal), but immediately writes a
  // registry record -- the same stand-in technique the reuse-detection
  // tests above use with a real startCanvasServer -- so awaitRecord below
  // finds it on its very first poll instead of waiting out the full
  // SPAWN_READY_MS timeout.
  mock.module("./host", () => ({
    ...hostReal,
    detectHost: () => ({
      name: "fake-probe-host",
      isAvailable: () => true,
      capabilities: hostReal.baseCapabilities,
      buildArgv: (spec: { argv: string[] }) => spec.argv,
      open: async (spec: { argv: string[] }) => {
        capturedArgv = spec.argv;
        await writeRecord({
          id,
          kind: "picker",
          scenario: "select",
          port: 1,
          token: newToken(),
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: "fake-probe-host",
        });
        return { host: "fake-probe-host" };
      },
    }),
  }));
  try {
    delete process.env.CANVAS_GRAPHICS;
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    delete process.env.WT_SESSION;
    process.env.TERM = "xterm-256color";
    delete process.env.TERM_PROGRAM;

    const { io, lines, exits } = captureIO();
    await runSpawn("picker", { id, scenario: "select" }, io);
    // Unlike runShow, runSpawn's success path calls neither io.exit nor
    // emit/io.write with an error -- it just returns, and the real CLI
    // process exits naturally. Only its catch block calls io.exit(1). A
    // non-empty `exits` here would mean this hit the catch block instead.
    expect(exits).toEqual([]);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.status).toBe("spawned");
    // Without the probe wired into runSpawn's resolveGraphics call, plain
    // detectGraphics(process.env) would resolve "quadrants" here instead
    // (no TERM_PROGRAM/WT_SESSION set), and this --graphics argument is
    // exactly what the spawned `show` process trusts (see buildShowArgv).
    const i = capturedArgv?.indexOf("--graphics") ?? -1;
    expect(i).toBeGreaterThan(-1);
    expect(capturedArgv?.[i + 1]).toBe("sixel");
  } finally {
    mock.module("./host/terminal-probe", () => ({
      ...terminalProbeReal,
      systemProbe: realSystemProbe,
    }));
    mock.module("./host", () => ({ ...hostReal, detectHost: realDetectHost }));
    if (saved.graphics === undefined) delete process.env.CANVAS_GRAPHICS;
    else process.env.CANVAS_GRAPHICS = saved.graphics;
    if (saved.tmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = saved.tmux;
    if (saved.wt === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = saved.wt;
    if (saved.term === undefined) delete process.env.TERM;
    else process.env.TERM = saved.term;
    if (saved.termProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.termProgram;
    await deleteRecord(id);
  }
});

// `--version` reported "1.0.0" while all four version-declaring files agreed
// on 0.2.x: a release that never existed. check-versions could not see it,
// because it compares JSON manifests and that was a string literal in code.
// It now derives from the manifest, and this asserts the observable result
// rather than the source text -- a grep for a semver literal would pass the
// day someone builds the string from two halves.
test("--version reports the version the manifest declares", () => {
  const manifest = require("../package.json") as { version: string };
  const run = Bun.spawnSync([process.execPath, "run", `${import.meta.dir}/cli.ts`, "--version"]);
  expect(run.exitCode).toBe(0);
  expect(new TextDecoder().decode(run.stdout).trim()).toBe(manifest.version);
});
