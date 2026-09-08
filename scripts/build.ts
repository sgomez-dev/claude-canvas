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

const result = await Bun.build({
  entrypoints: ["canvas/src/cli.ts"],
  target: "bun",
  outdir: "canvas/dist",
  naming: "cli.js",
  plugins: [stubDevtools],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const out = result.outputs[0]!;
console.log(`canvas/dist/cli.js  ${(out.size / 1024 / 1024).toFixed(2)} MB`);
