#!/usr/bin/env bun
/**
 * Validates structure and accuracy of every canvas/skills/<kind>/SKILL.md.
 *
 * This project has repeatedly shipped SKILL.md files that drifted out of
 * sync with the code they describe -- stale keybinding docs, a stale claim
 * about which canvases implement `onGet`, an advertised-but-removed feature.
 * The mechanical, cheap-to-check version of that drift is: does the set of
 * canvas kinds Claude Code's Agent Skill frontmatter documents match the set
 * `canvas/src/cli.ts` actually implements? That's what this script checks,
 * plus the structural basics (frontmatter present, description non-empty
 * and a reasonable length for autonomous trigger matching) and the same
 * dangerous-pattern scan scripts/lint-permissions.ts runs, via
 * scripts/lint-shared.ts so the pattern list has one home, not two.
 *
 * It deliberately does NOT try to validate every semantic claim in every
 * SKILL.md (e.g. whether a documented keybinding still fires, or whether an
 * `onGet` claim is still true) -- that's what human review and the
 * "Verifying a fix" discipline in CLAUDE.md are for. This checks only the
 * bounded, mechanical correspondence between "kinds that exist in code" and
 * "kinds that have a skill doc," because that specific kind of drift is the
 * one that's actually recurred in this project's own history and is cheap
 * to catch automatically.
 */
import { toPosixPath, extractFencedBlocks, scanFileForDangerousPatterns } from "./lint-shared";

const CLI_PATH = "canvas/src/cli.ts";
const SKILLS_GLOB = "canvas/skills/*/SKILL.md";

// canvas/skills/canvas/SKILL.md is the umbrella "start here" skill (see its
// own description: "Start here for terminal canvases") -- it documents the
// canvas system as a whole, not one specific kind, so it is deliberately
// excluded from the kind-correspondence check below rather than expected to
// match a KIND_DEFAULT_SCENARIO entry named "canvas".
const NON_KIND_SKILLS = new Set(["canvas"]);

// The existing SKILL.md descriptions in this repo range from 117 chars
// (flight) to 724 (the canvas umbrella skill), with every per-kind skill
// comfortably inside 120-260. These bounds sit outside that measured range
// with margin on both sides: short enough to still catch a near-empty
// placeholder description, long enough to allow the umbrella skill's
// broader scope, while still catching a wall-of-text description that would
// dilute Claude's autonomous trigger matching.
const MIN_DESCRIPTION_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 900;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

interface Frontmatter {
  name: string | null;
  description: string | null;
  hasFrontmatter: boolean;
}

function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\r?\n?/);
  if (!m) return { name: null, description: null, hasFrontmatter: false };
  const fm = m[1]!;

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1]!.trim() : null;

  let description: string | null = null;
  const blockMatch = fm.match(/^description:\s*\|\s*\n([\s\S]*)$/m);
  if (blockMatch) {
    const blockLines = blockMatch[1]!.split("\n");
    const contentLines: string[] = [];
    for (const line of blockLines) {
      // A block scalar's lines are all indented; an unindented, non-empty
      // line means we've walked past it into the next top-level key (or the
      // frontmatter's own trailing content). Stop there.
      if (line.trim().length > 0 && !/^[ \t]/.test(line)) break;
      contentLines.push(line);
    }
    const nonEmpty = contentLines.filter((l) => l.trim().length > 0);
    const minIndent =
      nonEmpty.length > 0 ? Math.min(...nonEmpty.map((l) => l.match(/^[ \t]*/)![0]!.length)) : 0;
    description = contentLines.map((l) => l.slice(minIndent)).join("\n").trim();
  } else {
    const inlineMatch = fm.match(/^description:\s*(.+)$/m);
    if (inlineMatch) description = inlineMatch[1]!.trim();
  }

  return { name, description, hasFrontmatter: true };
}

/**
 * `KIND_DEFAULT_SCENARIO` in cli.ts is the authoritative list of canvas
 * kinds (see its own comment there: "One map, so a kind's default cannot
 * drift from the scenarios actually registered for it"). Extracted by
 * locating that map literal and reading its entries' first element, rather
 * than importing cli.ts directly -- cli.ts has top-level side effects
 * (registering the commander program) that make it unsuitable to import
 * from a lint script.
 */
async function readKnownKinds(cliPath: string): Promise<string[]> {
  const file = Bun.file(cliPath);
  if (!(await file.exists())) {
    fail(`${cliPath} is missing -- cannot determine the authoritative list of canvas kinds.`);
  }
  const content = await file.text();
  const mapMatch = content.match(/KIND_DEFAULT_SCENARIO\s*=\s*new Map\(\[([\s\S]*?)\]\)/);
  if (!mapMatch) {
    fail(
      `Could not find "KIND_DEFAULT_SCENARIO = new Map([...])" in ${cliPath}. ` +
        `Has the authoritative kind list moved or been renamed? Update this script's regex to match.`
    );
  }
  const body = mapMatch[1]!;
  const kinds: string[] = [];
  const entryRegex = /\[\s*"([^"]+)"\s*,\s*"[^"]+"\s*\]/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(body))) kinds.push(entryMatch[1]!);
  if (kinds.length === 0) {
    fail(`Found KIND_DEFAULT_SCENARIO in ${cliPath} but could not parse any kind entries out of it.`);
  }
  return kinds;
}

async function main() {
  const knownKinds = await readKnownKinds(CLI_PATH);
  const knownKindSet = new Set(knownKinds);

  const skillDirs: { dirName: string; filePath: string }[] = [];
  for (const relPath of new Bun.Glob(SKILLS_GLOB).scanSync(".")) {
    const filePath = toPosixPath(relPath);
    const dirName = filePath.split("/").slice(-2, -1)[0]!;
    skillDirs.push({ dirName, filePath });
  }

  const issues: string[] = [];
  const dangerousIssues: Array<{ file: string; line: number; label: string; reason: string; text: string }> = [];

  for (const { dirName, filePath } of skillDirs) {
    const content = await Bun.file(filePath).text();
    const fm = parseFrontmatter(content);

    if (!fm.hasFrontmatter) {
      issues.push(`${filePath}: no frontmatter block found (must start with "---" ... "---").`);
      continue;
    }
    if (!fm.name) {
      issues.push(`${filePath}: frontmatter has no "name" field.`);
    } else if (fm.name !== dirName) {
      issues.push(`${filePath}: frontmatter "name: ${fm.name}" does not match its directory "${dirName}".`);
    }
    if (!fm.description || fm.description.length === 0) {
      issues.push(`${filePath}: frontmatter has no (or empty) "description" field.`);
    } else {
      const len = fm.description.length;
      if (len < MIN_DESCRIPTION_LENGTH) {
        issues.push(
          `${filePath}: description is ${len} chars, below the ${MIN_DESCRIPTION_LENGTH}-char minimum -- ` +
            `too short to reliably tell Claude when to invoke this skill.`
        );
      } else if (len > MAX_DESCRIPTION_LENGTH) {
        issues.push(
          `${filePath}: description is ${len} chars, above the ${MAX_DESCRIPTION_LENGTH}-char maximum -- ` +
            `long enough to dilute autonomous trigger matching.`
        );
      }
    }

    // Kind correspondence: every skill dir that isn't a known non-kind
    // umbrella doc must name a kind that still exists in cli.ts.
    if (!NON_KIND_SKILLS.has(dirName) && !knownKindSet.has(dirName)) {
      issues.push(
        `${filePath}: describes kind "${dirName}", which is not in ${CLI_PATH}'s KIND_DEFAULT_SCENARIO ` +
          `(known kinds: ${knownKinds.join(", ")}). This looks like a doc for a removed or renamed kind.`
      );
    }

    dangerousIssues.push(...scanFileForDangerousPatterns(filePath, content));
  }

  // Every real kind must have a skill doc.
  const documentedDirNames = new Set(skillDirs.map((s) => s.dirName));
  for (const kind of knownKinds) {
    if (!documentedDirNames.has(kind)) {
      issues.push(`canvas/skills/${kind}/SKILL.md is missing -- "${kind}" is a real kind with no skill doc.`);
    }
  }

  if (dangerousIssues.length > 0) {
    for (const issue of dangerousIssues) {
      issues.push(`${issue.file}:${issue.line}: dangerous pattern [${issue.label}] -- ${issue.reason}\n    ${issue.text}`);
    }
  }

  console.log(
    `Scanned ${skillDirs.length} skill doc(s) against ${knownKinds.length} known canvas kind(s) ` +
      `(${knownKinds.join(", ")}).`
  );

  if (issues.length > 0) {
    console.error(`\n${issues.length} issue(s) found:\n`);
    for (const issue of issues) console.error(`  - ${issue}`);
    console.error(`\nlint-skills: FAILED`);
    process.exit(1);
  }

  console.log(`lint-skills: OK -- structure valid, every kind has a doc, every doc names a real kind.`);
}

await main();
