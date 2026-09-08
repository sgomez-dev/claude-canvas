#!/usr/bin/env bun
import { program } from "commander";
import { assertIdent } from "./runtime/validate";
import { configPath, logPath } from "./runtime/paths";
import {
  getValue,
  pushUpdate,
  requestClose,
  waitForOutcome,
  DEFAULT_WAIT_MS,
} from "./runtime/client";
import { awaitRecord, listRecords, type CanvasRecord } from "./runtime/registry";
import { getScenario, listScenarios } from "./scenarios/registry";
import { detectHost } from "./host";

type Writer = (s: string) => boolean;

// `assertIdent` only validates identifier *shape* (charset, length); it says
// nothing about whether a kind is one implemented by canvases/index.tsx. A
// simple typo (e.g. "documnet") passes assertIdent and used to reach
// renderCanvas's switch, whose default branch called process.exit(1) from
// inside what can be a spawned pane — process.exit doesn't unwind, so the
// pane's own exit-0 handling never ran, leaving an unremovable pane on
// Windows. Checking membership here, before any pane is spawned or
// renderCanvas is called, is what actually prevents that.
//
// The value is that kind's default scenario. This used to be a bare set,
// with every kind defaulting to "display" -- so `spawn flight` ran with
// scenario "display", which is not a scenario flight has, and only worked
// because flight.tsx ignores the string. The registry record then recorded
// a scenario that does not exist. One map, so a kind's default cannot drift
// from the scenarios actually registered for it.
export const KIND_DEFAULT_SCENARIO = new Map([
  ["calendar", "display"],
  ["document", "display"],
  ["flight", "booking"],
  ["diff", "review"],
  ["picker", "select"],
  ["form", "fill"],
  ["table", "display"],
  ["dashboard", "display"],
]);

function assertKnownKind(kind: string): string {
  if (!KIND_DEFAULT_SCENARIO.has(kind)) {
    throw new Error(
      `Unknown canvas kind: ${kind}. Expected one of: ${[...KIND_DEFAULT_SCENARIO.keys()].join(", ")}.`
    );
  }
  return kind;
}

// Shape-valid but nonexistent scenario names used to pass straight through
// to the canvas, which compared the string and silently rendered something
// else: `--scenario meting-picker` got a read-only calendar, with nothing
// reported and `wait` answering `pending` 55 s later. The registry knows
// every real (kind, scenario) pair, so this is the check it always should
// have been backing.
export function resolveScenario(kind: string, requested: string | undefined): string {
  const scenario = assertIdent("scenario", requested ?? KIND_DEFAULT_SCENARIO.get(kind)!);
  if (!getScenario(kind, scenario)) {
    throw new Error(
      `Unknown scenario for ${kind}: ${scenario}. ` +
        `Expected one of: ${listScenarios(kind).map((x) => x.name).join(", ")}.`
    );
  }
  return scenario;
}

// Every command prints exactly one JSON object on stdout. Diagnostics go to
// stderr so they can never corrupt what Claude parses.
export function emit(value: unknown, write: Writer = process.stdout.write.bind(process.stdout)): void {
  write(`${JSON.stringify(value)}\n`);
}

export function resolveWaitTimeout(seconds: string | undefined): number {
  if (seconds === undefined) return DEFAULT_WAIT_MS;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --timeout: ${seconds}`);
  return Math.round(n * 1000);
}

// Thin wrapper around listRecords so the "nothing has ever been registered"
// path (canvasesDir() does not exist yet) can be exercised directly in
// tests, without going through commander's process.exit-laden actions.
// listRecords already handles the missing-directory case; this just gives
// that first-run behavior a name to assert on from cli.test.ts.
export async function listCanvases(): Promise<{ status: "ok"; canvases: CanvasRecord[] }> {
  return { status: "ok", canvases: await listRecords() };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  emit({ status: "error", message });
  process.exit(1);
}

// Dependency-injection seam so runShow/runSpawn's actual failure paths
// (assertIdent, config validation) are testable without a real process.exit
// tearing down the test runner, and without duplicating emit's write logic.
export interface ActionIO {
  write: Writer;
  exit: (code: number) => void;
}
const defaultIO: ActionIO = {
  write: process.stdout.write.bind(process.stdout),
  exit: (code) => process.exit(code),
};

interface ShowOpts {
  id?: string;
  scenario?: string;
  configFile?: string;
  offline?: boolean;
}

export async function runShow(kind: string, opts: ShowOpts, io: ActionIO = defaultIO): Promise<void> {
  try {
    const id = assertIdent("id", opts.id ?? `${kind}-1`);
    assertIdent("kind", kind);
    assertKnownKind(kind);
    const scenario = resolveScenario(kind, opts.scenario);
    const config = opts.configFile ? await Bun.file(opts.configFile).json() : undefined;
    process.stdout.write(`\x1b]0;canvas: ${kind}\x07`);
    const { renderCanvas } = await import("./canvases");
    await renderCanvas(kind, id, config, { scenario, enabled: !opts.offline } as never);
  } catch (e) {
    const message = (e as Error).message;
    process.stderr.write(`${message}\n`);
    emit({ status: "error", message }, io.write);
  } finally {
    // Always exit 0, success or failure: a non-zero exit leaves an
    // unremovable pane on Windows, so a thrown assertIdent/JSON error must
    // never escape this action uncaught.
    io.exit(0);
  }
}

// Generous on purpose: the measured spawn-to-reachable window is 0-1 s on
// this machine, and a cold Bun start on a loaded Windows box is the slow
// case this has to tolerate without a false negative.
const SPAWN_READY_MS = 10_000;

interface SpawnOpts {
  id?: string;
  scenario?: string;
  config?: string;
}

export async function runSpawn(kind: string, opts: SpawnOpts, io: ActionIO = defaultIO): Promise<void> {
  try {
    const id = assertIdent("id", opts.id ?? `${kind}-1`);
    assertIdent("kind", kind);
    assertKnownKind(kind);
    const scenario = resolveScenario(kind, opts.scenario);
    const argv = [
      process.execPath,
      "run",
      // `import.meta.path`, not a hardcoded `cli.ts` next to it. The shipped
      // plugin runs a bundle at dist/cli.js -- an installed plugin is a git
      // clone with no node_modules, so nothing that imports ink at runtime
      // can render -- and the old form built a path to a `cli.ts` that does
      // not exist there. The pane opened and the canvas inside it died
      // instantly. `import.meta.path` is whichever entry point is actually
      // running, source or bundle.
      import.meta.path,
      "show",
      kind,
      "--id",
      id,
      "--scenario",
      scenario,
    ];
    if (opts.config) {
      // Validate before writing: a malformed --config must never reach
      // configPath(id), or spawn would report {"status":"spawned"} while
      // the pane process silently crashes on an unhandled rejection trying
      // to JSON.parse it back in `show` — the zombie-pane failure class
      // this project has fought since Task 6/7.
      try {
        JSON.parse(opts.config);
      } catch {
        throw new Error("Invalid --config: not valid JSON");
      }
      // Config travels by file: Windows caps a command line near 32 KB, and
      // Phase 3 screenshots would blow past it.
      const path = configPath(id);
      await Bun.write(path, opts.config);
      argv.push("--config-file", path);
    }
    const host = detectHost();
    const handle = await host.open({ argv, title: `canvas: ${kind}`, ratio: 0.67 });

    // Do not report success until the canvas is actually reachable. Opening
    // the pane is not the same as the canvas being up: inside it, Bun has
    // to start, Ink has to mount, the server has to bind and the registry
    // record has to be written. `spawn` used to return before all of that,
    // so a `wait` issued immediately after answered "no canvas <id>" for a
    // canvas that was merely still starting. Measured window on this
    // machine: 0-1 s, so 10 s is far beyond any healthy start.
    const record = await awaitRecord(id, SPAWN_READY_MS);
    if (!record) {
      throw new Error(
        `Pane opened, but canvas ${id} did not become reachable within ` +
          `${SPAWN_READY_MS / 1000}s. It may have failed to start; see ${logPath(id)}. ` +
          `The pane may still be open and must be closed by hand.`
      );
    }
    if (record.lastError) throw new Error(`Canvas ${id} failed to start: ${record.lastError}`);
    emit({ status: "spawned", id, host: handle.host }, io.write);
  } catch (e) {
    const message = (e as Error).message;
    process.stderr.write(`${message}\n`);
    emit({ status: "error", message }, io.write);
    io.exit(1);
  }
}

program.name("claude-canvas").version("1.0.0");

program
  .command("show <kind>")
  .option("--id <id>")
  .option("--scenario <name>")
  .option("--config-file <path>")
  .option("--offline", "render without opening a server (used by tests)")
  .action((kind: string, opts) => runShow(kind, opts));

program
  .command("spawn <kind>")
  .option("--id <id>")
  .option("--scenario <name>")
  .option("--config <json>")
  .action((kind: string, opts) => runSpawn(kind, opts));

program
  .command("wait <id>")
  .option("--timeout <seconds>")
  .action(async (id: string, opts) => {
    try {
      assertIdent("id", id);
      const result = await waitForOutcome(id, resolveWaitTimeout(opts.timeout));
      emit(result);
      process.exit(result.status === "disconnected" || result.status === "error" ? 1 : 0);
    } catch (e) {
      fail((e as Error).message);
    }
  });

// Exported for the same reason resolveWaitTimeout is: the argument rules are
// worth testing without going through commander's process.exit-laden action.
export async function resolveUpdateConfig(opts: {
  config?: string;
  configFile?: string;
}): Promise<unknown> {
  // Exactly one, not "either": accepting both would silently pick a winner,
  // and accepting neither would push `undefined` as a config.
  if ((opts.config === undefined) === (opts.configFile === undefined)) {
    throw new Error("update needs exactly one of --config or --config-file");
  }
  if (opts.configFile) return await Bun.file(opts.configFile).json();
  try {
    return JSON.parse(opts.config!);
  } catch {
    throw new Error("Invalid --config: not valid JSON");
  }
}

// The controller half of the protocol's `update` message. Without this verb
// the message, `useCanvasServer`'s `onUpdate` and document.tsx's handler
// were unreachable end to end -- the roadmap chose TCP over
// files-plus-polling because polling "gives up server-push to the canvas —
// which live `update` needs", and that capability had no way to be invoked.
program
  .command("update <id>")
  .option("--config <json>")
  .option("--config-file <path>")
  .action(async (id: string, opts: { config?: string; configFile?: string }) => {
    try {
      assertIdent("id", id);
      await pushUpdate(id, await resolveUpdateConfig(opts));
      emit({ status: "updated", id });
    } catch (e) {
      fail((e as Error).message);
    }
  });

program.command("get <id> <key>").action(async (id: string, key: string) => {
  try {
    assertIdent("id", id);
    assertIdent("key", key);
    emit({ status: "ok", key, data: await getValue(id, key) });
  } catch (e) {
    fail((e as Error).message);
  }
});

program.command("close <id>").action(async (id: string) => {
  try {
    assertIdent("id", id);
    // Ask, never kill. Killing leaves a zombie pane on Windows.
    await requestClose(id);
    emit({ status: "closing", id });
  } catch (e) {
    fail((e as Error).message);
  }
});

program.command("list").action(async () => {
  emit(await listCanvases());
});

// Gives the scenario registry a consumer, and gives a controller a way to
// discover what it can ask for -- including `interactionMode`, which is how
// it knows whether to expect a result at all: a "view-only" scenario has no
// `selected` outcome, so its `wait` ending in `cancelled` is success.
program
  .command("scenarios")
  .argument("[kind]")
  .action((kind: string | undefined) => {
    try {
      if (kind !== undefined) {
        assertIdent("kind", kind);
        assertKnownKind(kind);
      }
      emit({
        status: "ok",
        scenarios: listScenarios(kind).map((x) => ({
          kind: x.canvasKind,
          name: x.name,
          description: x.description,
          interactionMode: x.interactionMode,
          isDefault: KIND_DEFAULT_SCENARIO.get(x.canvasKind) === x.name,
        })),
      });
    } catch (e) {
      fail((e as Error).message);
    }
  });

program.command("env").action(() => {
  try {
    const host = detectHost();
    emit({ status: "ok", host: host.name, capabilities: host.capabilities(process.env) });
  } catch (e) {
    emit({ status: "ok", host: null, message: (e as Error).message });
  }
});

// parseAsync (not parse) so a rejection from an async .action() handler is
// actually caught by Commander instead of becoming an unhandled-rejection
// crash outside its control.
if (import.meta.main) program.parseAsync();
