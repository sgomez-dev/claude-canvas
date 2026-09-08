import type { DiffFile, DiffHunk, DiffLine } from "./types";

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|(\/dev\/null))$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_RE = /^Binary files (.+) and (.+) differ$/;

function splitIntoFileBlocks(text: string): string[] {
  const trimmed = text.replace(/\r\n/g, "\n");
  if (trimmed.trim().length === 0) return [];
  const lines = trimmed.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  // Tracks whether the block currently being accumulated has already
  // consumed its own `--- `/`+++ ` header pair. A well-formed file block
  // (git-style or plain `diff -u` style) contains exactly one such pair,
  // immediately before its hunks. So a `--- `/`+++ ` pair seen again after
  // one has already been consumed for the current block cannot be a
  // continuation of that block -- it must belong to the next file -- while
  // the FIRST such pair for a block (whether it's a plain diff's very first
  // file, or the expected `--- `/`+++ ` line pair that follows a `diff
  // --git` header) is not itself a new block start.
  let seenHeaderInCurrent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isGitHeader = FILE_HEADER_RE.test(line);
    // A `--- `/`+++ ` pair is only ever a file header, never accidental
    // diff-body content (diff body lines never start with those exact
    // prefixes in that combination). Previously this only recognized a new
    // block starting at a bare `--- a/...` line for the VERY FIRST file
    // (guarded by `current.length === 0`) -- a second plain-format file's
    // `--- a/y` line was swallowed into the first file's block as ordinary
    // content, misattributing its hunks under the first file's path.
    const isHeaderPair = OLD_PATH_RE.test(line) && NEW_PATH_RE.test(lines[i + 1] ?? "");
    const startsNewBlock = isGitHeader || (isHeaderPair && seenHeaderInCurrent);
    if (startsNewBlock) {
      if (current.length > 0) blocks.push(current);
      current = [line];
      seenHeaderInCurrent = false;
    } else {
      current.push(line);
      if (isHeaderPair) seenHeaderInCurrent = true;
    }
  }
  if (current.length > 0) blocks.push(current);
  if (blocks.length === 0) {
    throw new DiffParseError("Input does not look like a unified diff.");
  }
  return blocks.map((b) => b.join("\n"));
}

function parseFileBlock(block: string): DiffFile {
  const lines = block.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldIsDevNull = false;
  let newIsDevNull = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let binary = false;
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const gitHeader = FILE_HEADER_RE.exec(line);
    if (gitHeader) {
      oldPath = gitHeader[1];
      newPath = gitHeader[2];
      continue;
    }
    const renameFromMatch = RENAME_FROM_RE.exec(line);
    if (renameFromMatch) {
      renameFrom = renameFromMatch[1];
      continue;
    }
    const renameToMatch = RENAME_TO_RE.exec(line);
    if (renameToMatch) {
      renameTo = renameToMatch[1];
      continue;
    }
    const binaryMatch = BINARY_RE.exec(line);
    if (binaryMatch) {
      binary = true;
      continue;
    }
    const oldMatch = OLD_PATH_RE.exec(line);
    if (oldMatch) {
      if (oldMatch[2]) oldIsDevNull = true;
      else oldPath = oldMatch[1];
      continue;
    }
    const newMatch = NEW_PATH_RE.exec(line);
    if (newMatch) {
      if (newMatch[2]) newIsDevNull = true;
      else newPath = newMatch[1];
      bodyStart = i + 1;
      break;
    }
  }

  // A file that is both renamed AND modified (git's rename detection is on
  // by default and commonly produces exactly this shape: `rename from`/
  // `rename to` lines followed by `---`/`+++`/`@@` hunks) must NOT return
  // here -- it needs to fall through to the same binary-detection and
  // hunk-parsing logic every other file block goes through, so its hunks
  // (if any exist in the block) get parsed instead of silently discarded. A
  // pure rename with no hunks still correctly ends up with `hunks: []`
  // below, since `bodyStart` stays -1 when no `--- `/`+++ ` pair is present.
  let finalOldPath: string;
  let finalNewPath: string;
  let status: DiffFile["status"];
  if (renameFrom && renameTo) {
    finalOldPath = renameFrom;
    finalNewPath = renameTo;
    status = "renamed";
  } else {
    if (!oldPath && !newPath) {
      throw new DiffParseError(`Could not determine file path in block:\n${block.slice(0, 200)}`);
    }
    finalOldPath = oldPath ?? newPath!;
    finalNewPath = newPath ?? oldPath!;
    status = oldIsDevNull ? "added" : newIsDevNull ? "deleted" : "modified";
  }

  if (binary) {
    return { oldPath: finalOldPath, newPath: finalNewPath, status, binary: true, hunks: [] };
  }

  const hunks: DiffHunk[] = [];
  let hunkIndex = 0;
  let i = bodyStart;
  while (i >= 0 && i < lines.length) {
    const header = HUNK_HEADER_RE.exec(lines[i]!);
    if (!header) {
      i++;
      continue;
    }
    const headerLine = lines[i]!;
    const oldStart = Number(header[1]);
    const oldLines = header[2] !== undefined ? Number(header[2]) : 1;
    const newStart = Number(header[3]);
    const newLines = header[4] !== undefined ? Number(header[4]) : 1;
    const hunkLines: DiffLine[] = [];
    let oldLineNo = oldStart;
    let newLineNo = newStart;
    i++;
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!) && !FILE_HEADER_RE.test(lines[i]!)) {
      const raw = lines[i]!;
      if (raw.startsWith("\\ No newline")) {
        i++;
        continue;
      }
      if (raw === "" && i === lines.length - 1) {
        i++;
        continue;
      }
      const marker = raw[0];
      const content = raw.slice(1);
      if (marker === "+") {
        hunkLines.push({ type: "add", content, newLineNo: newLineNo++ });
      } else if (marker === "-") {
        hunkLines.push({ type: "remove", content, oldLineNo: oldLineNo++ });
      } else {
        hunkLines.push({ type: "context", content, oldLineNo: oldLineNo++, newLineNo: newLineNo++ });
      }
      i++;
    }
    hunks.push({
      id: `${finalNewPath}#${hunkIndex}`,
      header: headerLine,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: hunkLines,
    });
    hunkIndex++;
  }

  return { oldPath: finalOldPath, newPath: finalNewPath, status, binary: false, hunks };
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const blocks = splitIntoFileBlocks(text);
  return blocks.map((block) => parseFileBlock(block));
}
