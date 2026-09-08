export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNo?: number; // present for "context" and "remove", absent for "add"
  newLineNo?: number; // present for "context" and "add", absent for "remove"
}

export interface DiffHunk {
  id: string; // `${file.newPath}#${index}`
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
}

export interface DiffReviewConfig {
  title?: string;
  diffText: string;
}

export type HunkDecision = "approved" | "rejected";

export interface DiffReviewResult {
  decisions: Array<{ hunkId: string; decision: HunkDecision }>;
}
