import { parseUnifiedDiff, DiffParseError } from "./parser";
import type { DiffFile, DiffReviewConfig } from "./types";

interface ParsedDiff {
  files: DiffFile[];
  error: string | null;
}

/**
 * Parses the config's diff text into files, or reports why it could not.
 *
 * Lifted out of diff.tsx unchanged so the canvas shell and any canvas
 * embedding the diff view treat a bad config identically. Empty or
 * whitespace-only text is deliberately not an error -- it is an empty
 * review, which the view renders as "Nothing to review."
 */
export function parseDiffConfig(config: DiffReviewConfig | undefined): ParsedDiff {
    if (!config?.diffText || config.diffText.trim().length === 0) {
      return { files: [], error: null };
    }
    try {
      return { files: parseUnifiedDiff(config.diffText), error: null };
    } catch (e) {
      return { files: [], error: e instanceof DiffParseError ? e.message : "Failed to parse diff." };
    }
}
