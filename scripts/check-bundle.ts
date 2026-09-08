#!/usr/bin/env bun
/**
 * Fails if the committed bundle does not match the current source.
 *
 * `canvas/dist/cli.js` is a build artifact in version control, which is
 * normally a bad idea and here is the only way a `/plugin install` works
 * with no setup: the plugin arrives as a git clone with no node_modules, so
 * anything that imported `ink` at runtime could not render at all. The cost
 * of committing it is that it can go stale silently, and this is what stops
 * that -- CI runs it, so a source change without a rebuild fails there
 * rather than shipping a plugin that renders the previous version.
 */
import { $ } from "bun";

const BUNDLE = "canvas/dist/cli.js";
const TMP = "/tmp/claude-canvas-bundle-check.js";

const committed = Bun.file(BUNDLE);
if (!(await committed.exists())) {
  console.error(`${BUNDLE} is missing. Run: bun run build`);
  process.exit(1);
}

await $`bun build canvas/src/cli.ts --target=bun --external react-devtools-core --outfile ${TMP}`.quiet();

const [a, b] = await Promise.all([committed.text(), Bun.file(TMP).text()]);
if (a !== b) {
  console.error(
    `${BUNDLE} is stale: it does not match a fresh build of canvas/src/cli.ts.\n` +
      `Run \`bun run build\` and commit the result.`
  );
  process.exit(1);
}
console.log(`${BUNDLE} is up to date (${(a.length / 1024 / 1024).toFixed(2)} MB)`);
