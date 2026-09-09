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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = "canvas/dist/cli.js";

const committed = Bun.file(BUNDLE);
if (!(await committed.exists())) {
  console.error(`${BUNDLE} is missing. Run: bun run build`);
  process.exit(1);
}
const committedText = await committed.text();

// Rebuild through the same script the committed bundle came from (so the
// comparison cannot drift because the two used different flags), but into a
// throwaway directory rather than BUNDLE itself. Building in place used to
// mean running this check "fixed" a stale bundle silently as a side effect
// of just checking it -- so the check's own error message ("Run `bun run
// build` and commit the result") was misleading: the build had already run
// by the time anyone read it. os.tmpdir(), not a hardcoded "/tmp": this
// runs on the Windows CI leg too, where "/tmp" is not a path.
const outdir = await mkdtemp(join(tmpdir(), "claude-canvas-bundle-check-"));
try {
  await $`bun run scripts/build.ts`.env({ ...process.env, CANVAS_BUILD_OUTDIR: outdir }).quiet();
  const fresh = await Bun.file(join(outdir, "cli.js")).text();

  if (committedText !== fresh) {
    console.error(
      `${BUNDLE} is stale: it does not match a fresh build of canvas/src/cli.ts.\n` +
        `Run \`bun run build\` and commit the result.`
    );
    process.exit(1);
  }
  console.log(`${BUNDLE} is up to date (${(fresh.length / 1024 / 1024).toFixed(2)} MB)`);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
