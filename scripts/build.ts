#!/usr/bin/env bun
/**
 * Builds the shipped CLI bundle.
 *
 * A `/plugin install` arrives as a git clone with no `node_modules`, so
 * anything that imports `ink` at runtime cannot render. The bundle exists so
 * the plugin needs no install step at all, which means it must have no
 * runtime imports left in it -- including the optional one Ink makes for
 * React DevTools, which is resolved to a stub here rather than externalised.
 */
import { plugin, type BunPlugin } from "bun";
import { resolve } from "node:path";

const stubDevtools: BunPlugin = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: resolve(import.meta.dir, "devtools-stub.ts"),
    }));
  },
};

// check-bundle.ts needs to build to a location OTHER than the committed
// canvas/dist/cli.js, to compare a fresh build against the committed one
// without overwriting the very file it's checking as a side effect of
// checking it. Rather than duplicate this build config there (which is
// exactly the drift the single-script setup below exists to prevent), it
// overrides the output directory through this env var and still goes
// through this same script for everything else (target, naming, the
// devtools stub).
const outdir = process.env.CANVAS_BUILD_OUTDIR ?? "canvas/dist";

const result = await Bun.build({
  entrypoints: ["canvas/src/cli.ts"],
  target: "bun",
  outdir,
  naming: "cli.js",
  plugins: [stubDevtools],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const out = result.outputs[0]!;
console.log(`${outdir}/cli.js  ${(out.size / 1024 / 1024).toFixed(2)} MB`);
