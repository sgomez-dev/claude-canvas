#!/usr/bin/env bun
/**
 * Fails if the shipped bundle cannot run without node_modules.
 *
 * That is the bundle's whole purpose, and it has been broken twice by
 * changes that looked harmless: once by `--external react-devtools-core`,
 * which left a runtime import the plugin could not resolve, and once by
 * `spawn` building its child's path as a hardcoded `cli.ts`. Neither showed
 * up in the test suite, because the suite runs inside the repository where
 * every dependency is present. This runs the bundle somewhere it is the
 * only file.
 */
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const BUNDLE = "canvas/dist/cli.js";
const dir = await mkdtemp(join(tmpdir(), "canvas-standalone-"));
try {
  await cp(BUNDLE, join(dir, "cli.js"));

  // `scenarios` exercises the scenario registry, and `env` the host
  // detection -- neither needs a terminal, and both fail loudly if a module
  // is missing, since the failure happens at load.
  const scenarios = await $`bun run ${join(dir, "cli.js")} scenarios picker`.text();
  const parsed = JSON.parse(scenarios) as { status: string; scenarios: unknown[] };
  if (parsed.status !== "ok" || parsed.scenarios.length !== 1) {
    console.error(`unexpected scenarios output: ${scenarios}`);
    process.exit(1);
  }

  // The render path is the one that pulls in ink, react and yoga. `show`
  // would block on a TUI, so this imports the canvas module directly, which
  // is what fails when a dependency is missing.
  const probe = join(dir, "probe.ts");
  await Bun.write(
    probe,
    `const m = await import(${JSON.stringify(join(dir, "cli.js"))});\n` +
      `console.log(typeof m === "object" ? "loaded" : "unexpected");\n`
  );
  const loaded = (await $`bun run ${probe}`.text()).trim().split("\n").pop();
  if (loaded !== "loaded") {
    console.error(`bundle did not load standalone: ${loaded}`);
    process.exit(1);
  }

  console.log("bundle runs standalone, with no node_modules");
} finally {
  await rm(dir, { recursive: true, force: true });
}
