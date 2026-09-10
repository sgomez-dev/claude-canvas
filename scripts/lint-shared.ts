/**
 * Shared helpers for scripts/lint-permissions.ts and scripts/lint-skills.ts.
 *
 * Both scripts scan the same fenced code blocks in canvas/skills/*\/SKILL.md
 * and canvas/commands/*.md for copy-pasteable examples, and both need to flag
 * genuinely dangerous shell patterns in them. Keeping the fence-extraction
 * logic and the dangerous-pattern list here, instead of duplicating either in
 * both scripts, is the same "one source of truth" preference this project
 * has enforced on itself repeatedly elsewhere (KIND_DEFAULT_SCENARIO in
 * cli.ts is one map so a kind's default scenario cannot drift from the
 * scenarios actually registered for it; the build config lives once in
 * scripts/build.ts so check-bundle.ts can't compare against a differently
 * configured rebuild). Two copies of a dangerous-pattern list are exactly
 * the kind of thing that drifts silently when one gets updated and the
 * other doesn't.
 */

export interface FencedBlock {
  /** The language tag after the opening ``` fence, e.g. "bash", "json", or "" if untagged. */
  lang: string;
  /** 1-based line number, in the original file, of the first line of code inside the fence. */
  startLine: number;
  lines: string[];
}

/** Extract fenced (```lang ... ```) code blocks from a markdown file's text. */
export function extractFencedBlocks(content: string): FencedBlock[] {
  // Files in this repo are checked out with CRLF line endings (core.autocrlf
  // on Windows); normalize so line numbers and matching are stable across
  // platforms.
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const openMatch = rawLines[i]!.match(/^\s*```(\S*)\s*$/);
    if (openMatch) {
      const lang = openMatch[1] ?? "";
      const startLine = i + 2; // 1-based; first code line is the one after the fence
      const lines: string[] = [];
      i++;
      while (i < rawLines.length && !/^\s*```\s*$/.test(rawLines[i]!)) {
        lines.push(rawLines[i]!);
        i++;
      }
      blocks.push({ lang, startLine, lines });
      i++; // skip the closing fence
      continue;
    }
    i++;
  }
  return blocks;
}

interface DangerousPattern {
  regex: RegExp;
  label: string;
  reason: string;
}

// Adapted from claude-skills' scripts/lint-permissions.sh dangerous-pattern
// list, but pruned to this repo's actual shape. Every example in
// canvas/skills and canvas/commands is either a `canvas` CLI invocation
// (`bun run .../cli.js ...`) or a settings.json snippet -- not arbitrary
// shell, SQL, or infra commands -- so patterns from that reference list with
// no way to ever appear here (`terraform destroy`, `DROP TABLE`, `docker
// push`, ...) are deliberately left out rather than carried over unused.
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|~)(\s|$)/,
    label: "rm -rf on root or home",
    reason: "would delete the whole filesystem or home directory if pasted as-is",
  },
  {
    regex: /\bgit\s+push\b[^\n]*\s--force(?!-with-lease)\b/,
    label: "git push --force",
    reason: "overwrites remote history destructively; use --force-with-lease, or omit from examples",
  },
  {
    regex: /--no-verify\b/,
    label: "--no-verify",
    reason: "skips commit/push hooks (lint, tests, secret scanning) -- should never appear in copy-paste docs",
  },
  {
    regex: /(curl|wget)\s+[^\n|]*\|\s*(sudo\s+)?(bash|sh)\b/,
    label: "curl/wget piped into a shell",
    reason: "executes unreviewed remote content directly; do not model this pattern in docs",
  },
  {
    regex: /\beval\s*\(/,
    label: "eval(",
    reason: "executes an arbitrary constructed string as code",
  },
];

export interface DangerousPatternHit {
  label: string;
  reason: string;
  line: string;
}

export function scanLineForDangerousPatterns(line: string): DangerousPatternHit[] {
  const hits: DangerousPatternHit[] = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.regex.test(line)) hits.push({ label: p.label, reason: p.reason, line: line.trim() });
  }
  return hits;
}

/** Scan every fenced block of a file for dangerous patterns, returning file-relative line numbers. */
export function scanFileForDangerousPatterns(
  filePath: string,
  content: string
): Array<{ file: string; line: number; label: string; reason: string; text: string }> {
  const issues: Array<{ file: string; line: number; label: string; reason: string; text: string }> = [];
  for (const block of extractFencedBlocks(content)) {
    block.lines.forEach((line, offset) => {
      for (const hit of scanLineForDangerousPatterns(line)) {
        issues.push({
          file: filePath,
          line: block.startLine + offset,
          label: hit.label,
          reason: hit.reason,
          text: hit.line,
        });
      }
    });
  }
  return issues;
}

/** Normalize a Bun.Glob path (which yields backslashes on Windows) to forward slashes for display. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}
