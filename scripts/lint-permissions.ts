#!/usr/bin/env bun
/**
 * Cross-checks `.claude/settings.json`'s Bash allow rules against the CLI
 * invocations this repo's own docs tell people to copy-paste.
 *
 * A plugin manifest has no permissions field of its own (see
 * `canvas/README.md`'s "Skip the permission prompt on every invocation"),
 * so the allow rule in `.claude/settings.json` is the only thing standing
 * between an autonomous `bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ...` call
 * and a permission prompt on every single invocation. That rule is hand-
 * written prose matched against real command lines, so it can silently stop
 * matching anything: this repo shipped exactly that bug, briefly, as
 * `Bash(bun ${CLAUDE_PLUGIN_ROOT}/dist/cli.js:*)` -- missing the word "run"
 * -- while every documented example in canvas/skills and canvas/commands
 * used `bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ...`. The rule would have
 * matched zero of them, and nothing would have failed loudly: every
 * invocation would just silently prompt again. This script is what catches
 * that class of drift before it ships.
 *
 * It also scans the same fenced code blocks for dangerous shell patterns
 * that should never appear in copy-pasteable documentation (see
 * scripts/lint-shared.ts).
 */
import { toPosixPath, extractFencedBlocks, scanFileForDangerousPatterns } from "./lint-shared";

const SETTINGS_PATH = ".claude/settings.json";

// Lines that look like an example CLI invocation worth checking coverage
// for. Every real example in this repo is `bun run
// ${CLAUDE_PLUGIN_ROOT}/dist/cli.js <verb> ...`, so this matches "bun run"
// followed eventually by something referencing cli.js, the same shape
// pointed at in the task this script implements.
const INVOCATION_LINE = /^\s*(bun run .*cli\.js\b.*)$/;

interface Invocation {
  file: string;
  line: number;
  text: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readAllowRules(settingsPath: string): Promise<string[]> {
  const file = Bun.file(settingsPath);
  if (!(await file.exists())) {
    fail(`${settingsPath} is missing -- cannot check permission coverage.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    fail(`${settingsPath} is not valid JSON: ${(err as Error).message}`);
  }
  const allow = (parsed as { permissions?: { allow?: unknown } })?.permissions?.allow;
  if (!Array.isArray(allow)) {
    fail(`${settingsPath} has no permissions.allow array.`);
  }
  return allow.filter((x): x is string => typeof x === "string");
}

/**
 * A Claude Code Bash allow rule looks like `Bash(<pattern>)`, where
 * `<pattern>` either ends in a `:*` wildcard (matching any arguments after
 * a literal command) or contains a bare `*` elsewhere. The "prefix" is
 * whatever literal text is guaranteed to appear before the first wildcard --
 * that's what a real invocation has to start with for the rule to cover it.
 * Rules that aren't `Bash(...)` at all are skipped: they don't grant Bash
 * invocations, so they can't cover a CLI invocation example either way.
 */
function extractBashPrefix(rule: string): string | null {
  const m = rule.match(/^Bash\((.*)\)$/s);
  if (!m) return null;
  const inner = m[1]!;
  if (inner.endsWith(":*")) return inner.slice(0, -2);
  const starIndex = inner.indexOf("*");
  return starIndex === -1 ? inner : inner.slice(0, starIndex);
}

async function collectInvocations(glob: string): Promise<{ files: string[]; invocations: Invocation[] }> {
  const files: string[] = [];
  const invocations: Invocation[] = [];
  for (const relPath of new Bun.Glob(glob).scanSync(".")) {
    const filePath = toPosixPath(relPath);
    files.push(filePath);
    const content = await Bun.file(filePath).text();
    for (const block of extractFencedBlocks(content)) {
      block.lines.forEach((line, offset) => {
        const m = line.match(INVOCATION_LINE);
        if (m) {
          invocations.push({ file: filePath, line: block.startLine + offset, text: m[1]!.trim() });
        }
      });
    }
  }
  return { files, invocations };
}

async function main() {
  const allowRules = await readAllowRules(SETTINGS_PATH);
  const prefixes = allowRules.map(extractBashPrefix).filter((p): p is string => p !== null);

  if (prefixes.length === 0) {
    fail(
      `${SETTINGS_PATH} has no Bash(...) allow rules at all -- ` +
        `every documented CLI invocation would prompt on every call.`
    );
  }

  const skillFiles = await collectInvocations("canvas/skills/*/SKILL.md");
  const commandFiles = await collectInvocations("canvas/commands/*.md");
  const allFiles = [...skillFiles.files, ...commandFiles.files];
  const allInvocations = [...skillFiles.invocations, ...commandFiles.invocations];

  const uncovered: Invocation[] = [];
  for (const inv of allInvocations) {
    const covered = prefixes.some((prefix) => inv.text.startsWith(prefix));
    if (!covered) uncovered.push(inv);
  }

  // Dangerous-pattern scan shares the same file set and the same fence
  // extraction the invocation check above uses.
  const dangerousIssues: Array<{ file: string; line: number; label: string; reason: string; text: string }> = [];
  for (const filePath of allFiles) {
    const content = await Bun.file(filePath).text();
    dangerousIssues.push(...scanFileForDangerousPatterns(filePath, content));
  }

  let hadError = false;

  if (uncovered.length > 0) {
    hadError = true;
    console.error(
      `${uncovered.length} documented CLI invocation(s) are not covered by any ` +
        `${SETTINGS_PATH} permissions.allow rule:\n`
    );
    for (const inv of uncovered) {
      console.error(`  ${inv.file}:${inv.line}  ${inv.text}`);
    }
    console.error(
      `\nAllow rule prefixes checked against: ${prefixes.map((p) => JSON.stringify(p)).join(", ")}\n` +
        `Either add/fix an allow rule so its prefix matches these invocations, or fix the examples.`
    );
  }

  if (dangerousIssues.length > 0) {
    hadError = true;
    console.error(`${dangerousIssues.length} dangerous pattern(s) found in documentation examples:\n`);
    for (const issue of dangerousIssues) {
      console.error(`  ${issue.file}:${issue.line}  [${issue.label}] ${issue.reason}`);
      console.error(`    ${issue.text}`);
    }
  }

  console.log(
    `\nScanned ${allFiles.length} file(s), checked ${allInvocations.length} invocation(s) against ` +
      `${prefixes.length} allow-rule prefix(es).`
  );

  if (hadError) {
    console.error(`\nlint-permissions: FAILED`);
    process.exit(1);
  }
  console.log(`lint-permissions: OK -- every invocation is covered, no dangerous patterns found.`);
}

await main();
