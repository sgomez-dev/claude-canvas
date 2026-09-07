#!/usr/bin/env bun
import { program } from "commander";
import { assertIdent } from "./runtime/validate";
import { configPath } from "./runtime/paths";
import { getValue, requestClose, waitForOutcome, DEFAULT_WAIT_MS } from "./runtime/client";
import { listRecords, type CanvasRecord } from "./runtime/registry";
import { detectHost } from "./host";

type Writer = (s: string) => boolean;

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
    const scenario = assertIdent("scenario", opts.scenario ?? "display");
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

interface SpawnOpts {
  id?: string;
  scenario?: string;
  config?: string;
}

export async function runSpawn(kind: string, opts: SpawnOpts, io: ActionIO = defaultIO): Promise<void> {
  try {
    const id = assertIdent("id", opts.id ?? `${kind}-1`);
    assertIdent("kind", kind);
    const scenario = assertIdent("scenario", opts.scenario ?? "display");
    const argv = [
      process.execPath,
      "run",
      `${import.meta.dir}/cli.ts`,
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
    assertIdent("id", id);
    const result = await waitForOutcome(id, resolveWaitTimeout(opts.timeout));
    emit(result);
    process.exit(result.status === "disconnected" || result.status === "error" ? 1 : 0);
  });

program.command("get <id> <key>").action(async (id: string, key: string) => {
  assertIdent("id", id);
  assertIdent("key", key);
  try {
    emit({ status: "ok", key, data: await getValue(id, key) });
  } catch (e) {
    fail((e as Error).message);
  }
});

program.command("close <id>").action(async (id: string) => {
  assertIdent("id", id);
  try {
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

program.command("env").action(() => {
  try {
    const host = detectHost();
    emit({ status: "ok", host: host.name, capabilities: host.capabilities(process.env) });
  } catch (e) {
    emit({ status: "ok", host: null, message: (e as Error).message });
  }
});

if (import.meta.main) program.parse();
