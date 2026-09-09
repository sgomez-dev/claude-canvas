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
 *
 * Every `bun run` below passes `--no-install`. Without it, this check
 * cannot actually fail on the regression it exists to catch: in a directory
 * with no node_modules present, Bun's own auto-install feature silently
 * resolves an "external" (unresolved) import from its global package cache
 * or, on a machine with network access, straight from the npm registry --
 * which defeats the premise that "no node_modules" means "no way to
 * satisfy this import" at all. Reproduced directly: rebuilding with
 * `react-devtools-core` externalized instead of stubbed (this file's
 * opening paragraph) still made every check below exit 0 without
 * `--no-install`, because auto-install quietly fetched the "missing"
 * package on its own.
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
  const scenarios = await $`bun run --no-install ${join(dir, "cli.js")} scenarios picker`.text();
  const parsed = JSON.parse(scenarios) as { status: string; scenarios: unknown[] };
  if (parsed.status !== "ok" || parsed.scenarios.length !== 1) {
    console.error(`unexpected scenarios output: ${scenarios}`);
    process.exit(1);
  }

  // The render path is the one that pulls in ink, react and yoga, and it is
  // reached only through `show`'s own lazy `await import("./canvases")` --
  // which this check used to "exercise" by importing the bundle's module
  // namespace directly. That never actually evaluated "./canvases" at all:
  // a dynamic import's target only runs when the import() expression itself
  // executes, and a bare `import(bundlePath)` never calls anything inside
  // cli.ts's `runShow`. So the previous version of this check verified
  // almost nothing about whether the bundle can actually RENDER a canvas.
  //
  // This invokes `show` for real, in `--offline` mode (so it never tries to
  // open an IPC server) with a minimal picker config, against this
  // process's real -- if non-interactive -- stdio. Measured directly: this
  // completes in well under a second and exits 0, printing a fully
  // rendered bordered frame with the configured title, even though Ink's
  // raw-mode setup fails on non-TTY stdin afterward (expected and harmless
  // here; irrelevant to what this check verifies). A `race` against a
  // generous timeout is still a safety net in case some environment makes
  // it hang instead of exiting.
  const configFile = join(dir, "probe-config.json");
  const probeMarker = "canvas-standalone-check-probe";
  await Bun.write(
    configFile,
    JSON.stringify({
      title: probeMarker,
      mode: "single",
      options: [{ id: "a", label: "A" }],
    })
  );
  const RENDER_TIMEOUT_MS = 15_000;
  const renderResult = await Promise.race([
    $`bun run --no-install ${join(dir, "cli.js")} show picker --id probe --offline --config-file ${configFile}`
      .nothrow()
      .quiet()
      .then((r) => ({ timedOut: false as const, r })),
    Bun.sleep(RENDER_TIMEOUT_MS).then(() => ({ timedOut: true as const })),
  ]);
  if (renderResult.timedOut) {
    console.error(
      `bundle did not complete 'show picker' within ${RENDER_TIMEOUT_MS}ms -- ` +
        `the render path (ink/react/yoga) may be hanging or broken standalone`
    );
    process.exit(1);
  }
  const out = renderResult.r.stdout.toString();
  // The configured title and a box-drawing border character are what an
  // actually-completed Ink render produces -- not just "the process didn't
  // crash". A module-resolution failure (this check's whole reason to
  // exist) never gets this far: `show`'s own try/catch reports it as a
  // JSON error instead (`{"status":"error","message":"Cannot find package
  // 'react-devtools-core'..."}`), with no rendered frame in the output at
  // all.
  if (!out.includes(probeMarker) || !out.includes("─")) {
    console.error(
      `bundle did not render a canvas standalone.\n` +
        `stdout: ${out}\n` +
        `stderr: ${renderResult.r.stderr.toString()}`
    );
    process.exit(1);
  }

  console.log("bundle runs standalone, with no node_modules, and renders a canvas");
} finally {
  await rm(dir, { recursive: true, force: true });
}
