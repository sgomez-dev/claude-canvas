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
    const raw: unknown = config?.diffText;
    // `diffText` must be checked as `unknown` before any string method
    // touches it: a number, array, object or boolean here used to reach
    // `.trim()` directly and throw a TypeError inside the `useMemo` that
    // calls this, during render -- before `useCanvasServer`'s effect ever
    // runs, so no registry record was written and the canvas was left
    // un-`wait`-able while Ink showed its raw error screen. Matches the
    // posture picker.tsx and form.tsx already take on their own configs.
    if (raw !== undefined && typeof raw !== "string") {
      return { files: [], error: "diff config: 'diffText' must be a string" };
    }
    if (!raw || raw.trim().length === 0) {
      return { files: [], error: null };
    }
    try {
      return { files: parseUnifiedDiff(raw), error: null };
    } catch (e) {
      return { files: [], error: e instanceof DiffParseError ? e.message : "Failed to parse diff." };
    }
}
