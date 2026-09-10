#!/usr/bin/env bun
/**
 * Fails if this repo's version-declaring files disagree.
 *
 * Four files each carry a version number that ought to move together:
 * the two package.json files (workspace root and canvas/), the plugin
 * manifest (canvas/.claude-plugin/plugin.json), and the marketplace listing
 * (.claude-plugin/marketplace.json)'s entry for the "canvas" plugin. Nothing
 * enforced they agree, and by the time this script was written they'd
 * already drifted: both package.json files sat at 0.1.0 while the plugin
 * manifest and marketplace listing -- the user/publish-facing versions --
 * A fifth version used to exist and is now gone: cli.ts wrote "1.0.0" into
 * commander's `.version()` as a literal, so `--version` reported a release
 * that never happened and nothing here could see it. It imports the manifest
 * instead, which makes that particular drift structurally impossible rather
 * than merely detectable, and canvas/src/cli.test.ts asserts the observable
 * output.
 *
 * had moved on to 0.2.0. The plugin manifest and marketplace version are
 * treated as the source of truth here (they're what a `/plugin install`
 * and the marketplace listing actually show a user), so a disagreement is
 * reported against them rather than against whichever file happens to run
 * first.
 */

const ROOT_PACKAGE_JSON = "package.json";
const CANVAS_PACKAGE_JSON = "canvas/package.json";
const PLUGIN_MANIFEST = "canvas/.claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";
const MARKETPLACE_PLUGIN_NAME = "canvas";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`${path} is missing.`);
  try {
    return JSON.parse(await file.text());
  } catch (err) {
    fail(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

interface VersionSource {
  file: string;
  /** Human-readable description of exactly what field this version came from. */
  field: string;
  version: string;
}

async function main() {
  const sources: VersionSource[] = [];

  const rootPkg = (await readJson(ROOT_PACKAGE_JSON)) as { version?: string };
  if (typeof rootPkg.version !== "string") fail(`${ROOT_PACKAGE_JSON} has no "version" field.`);
  sources.push({ file: ROOT_PACKAGE_JSON, field: "version", version: rootPkg.version });

  const canvasPkg = (await readJson(CANVAS_PACKAGE_JSON)) as { version?: string };
  if (typeof canvasPkg.version !== "string") fail(`${CANVAS_PACKAGE_JSON} has no "version" field.`);
  sources.push({ file: CANVAS_PACKAGE_JSON, field: "version", version: canvasPkg.version });

  const pluginManifest = (await readJson(PLUGIN_MANIFEST)) as { version?: string };
  if (typeof pluginManifest.version !== "string") fail(`${PLUGIN_MANIFEST} has no "version" field.`);
  sources.push({ file: PLUGIN_MANIFEST, field: "version", version: pluginManifest.version });

  const marketplace = (await readJson(MARKETPLACE_MANIFEST)) as {
    plugins?: Array<{ name?: string; version?: string }>;
  };
  const marketplaceEntry = marketplace.plugins?.find((p) => p.name === MARKETPLACE_PLUGIN_NAME);
  if (!marketplaceEntry) {
    fail(`${MARKETPLACE_MANIFEST} has no plugins[] entry named "${MARKETPLACE_PLUGIN_NAME}".`);
  }
  if (typeof marketplaceEntry.version !== "string") {
    fail(`${MARKETPLACE_MANIFEST}'s "${MARKETPLACE_PLUGIN_NAME}" plugin entry has no "version" field.`);
  }
  sources.push({
    file: MARKETPLACE_MANIFEST,
    field: `plugins[name="${MARKETPLACE_PLUGIN_NAME}"].version`,
    version: marketplaceEntry.version,
  });

  // Source of truth: the plugin manifest and marketplace listing, since
  // those are what a user actually sees (`/plugin install` and the
  // marketplace listing). They're required to agree with each other too --
  // this doesn't privilege one over the other, only over the two
  // package.json files.
  const truthVersion = pluginManifest.version;
  const truthAgrees = marketplaceEntry.version === truthVersion;

  const disagreements = sources.filter((s) => s.version !== truthVersion);

  console.log(`Checked ${sources.length} version declaration(s):`);
  for (const s of sources) console.log(`  ${s.file} (${s.field}): ${s.version}`);

  if (!truthAgrees || disagreements.length > 0) {
    console.error(
      `\nVersion mismatch. Source of truth (${PLUGIN_MANIFEST}): ${truthVersion}\n` +
        `Disagreeing file(s):`
    );
    for (const s of disagreements) {
      console.error(`  ${s.file}: ${s.version} (expected ${truthVersion})`);
    }
    console.error(`\ncheck-versions: FAILED`);
    process.exit(1);
  }

  console.log(`\ncheck-versions: OK -- all ${sources.length} files agree at ${truthVersion}.`);
}

await main();
