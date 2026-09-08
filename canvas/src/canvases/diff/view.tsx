import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DiffFile, DiffReviewResult, HunkDecision } from "./types";

export interface DiffViewProps {
  files: DiffFile[];
  title?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  focused: boolean;
  onSubmit(result: DiffReviewResult): void;
}

interface FlatHunkRef {
  fileIndex: number;
  hunkIndex: number;
}

// Rows this component spends on chrome rather than content: the file-list
// box's two borders and title, the hunk box's two borders plus its header
// and decision lines, and the footer's blank line plus hint.
const CHROME_ROWS = 9;
// The file list never takes more than this, so a 40-file diff cannot starve
// the hunk body it exists to help you read.
const MAX_FILE_ROWS = 5;

/**
 * The diff review's rendering and per-hunk decisions, knowing nothing about
 * IPC or outcomes.
 *
 * Escape belongs to the canvas shell -- see picker/view.tsx for why a view
 * must never swallow it. Enter does live here: "submit" is a view-level
 * gesture whose result the shell then owns, so the view may call onSubmit
 * more than once and the shell enforces first-outcome-wins.
 */
export function DiffView({
  files,
  title,
  budget: totalBudget,
  focused,
  onSubmit,
}: DiffViewProps): React.JSX.Element {
  const flatHunks: FlatHunkRef[] = useMemo(() => {
    const refs: FlatHunkRef[] = [];
    files.forEach((f, fileIndex) => {
      f.hunks.forEach((_h, hunkIndex) => refs.push({ fileIndex, hunkIndex }));
    });
    return refs;
  }, [files]);

  const [cursor, setCursor] = useState(0);
  // Mirrors `cursor` synchronously into a ref on every render (NOT inside a
  // useEffect, which would reintroduce the same one-render lag this is
  // fixing). useInput's handler is re-registered in a passive effect that
  // lags one render behind a state-driven re-render, so reading the
  // closed-over `cursor` directly in the "a"/"r" branches can observe a
  // stale value: press "j" then "a" fast enough and the approve/reject would
  // land on the PREVIOUS hunk, not the one just highlighted. Reading from
  // this ref always sees the latest committed cursor regardless of which
  // render's useInput registration is currently active.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // How far the current hunk's body is scrolled. Reset explicitly wherever
  // the cursor moves to another hunk, rather than in an effect keyed on
  // `cursor`: an effect would cost an extra render per navigation keystroke
  // and would land one render after the hunk it belongs to had already been
  // drawn at the old offset.
  const [lineOffset, setLineOffset] = useState(0);

  const [decisions, setDecisions] = useState<Map<string, HunkDecision>>(new Map());
  // Same stale-closure hazard as cursorRef above, for the submit branch's
  // read of `decisions`.
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;

  useInput((input, key) => {
    if (key.return) {
      // Submits even when there are no hunks, as long as the diff had files
      // -- a binary-only diff has nothing to approve, and reporting an empty
      // decision list ("reviewed, nothing to apply") is information, whereas
      // forcing the user to Escape reports `cancelled` and loses the
      // distinction between that and bailing out.
      if (files.length === 0) return;
      onSubmit({
        decisions: flatHunks.map((ref) => {
          const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
          return { hunkId: hunk.id, decision: decisionsRef.current.get(hunk.id) ?? "rejected" };
        }),
      });
      return;
    }
    if (flatHunks.length === 0) return;
    if (key.pageDown) {
      setLineOffset((o) => o + 1);
      return;
    }
    if (key.pageUp) {
      setLineOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      setLineOffset(0);
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(flatHunks.length - 1, c + 1));
      setLineOffset(0);
    } else if (input === "a") {
      const ref = flatHunks[cursorRef.current];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "approved"));
      }
    } else if (input === "r") {
      const ref = flatHunks[cursorRef.current];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "rejected"));
      }
    }
  }, { isActive: focused });

  // Only a genuinely empty diff gets the bare message. A diff whose files
  // are all binary has nothing to REVIEW but plenty to SHOW, and the spec
  // says a binary file is "shown as a label" -- the early return used to
  // fire first and hide the file list entirely.
  if (files.length === 0) {
    return (
      <Box borderStyle="round" padding={1}>
        <Text dimColor>Nothing to review.</Text>
      </Box>
    );
  }

  const currentRef = flatHunks[cursor];
  const currentFile = currentRef ? files[currentRef.fileIndex] : undefined;
  const currentHunk = currentRef ? currentFile?.hunks[currentRef.hunkIndex] : undefined;

  // A 200-line hunk, or a 40-file diff, used to render every row into a
  // fixed-height pane: the overflow pushed the footer hint and the decision
  // marker out of view, which for a diff reviewer means losing the one line
  // that tells you what state the hunk is in.
  const budget = Math.max(2, totalBudget - CHROME_ROWS);
  const fileRows = Math.max(1, Math.min(MAX_FILE_ROWS, files.length, budget - 1));
  const hunkRows = Math.max(1, budget - fileRows);

  // Both windows page rather than centre, for the same reason as picker's:
  // the view only moves when the cursor crosses a boundary instead of
  // shifting under the reader on every keypress.
  const fileWindowStart =
    files.length <= fileRows
      ? 0
      : Math.floor((currentRef?.fileIndex ?? 0) / fileRows) * fileRows;
  const visibleFiles = files.slice(fileWindowStart, fileWindowStart + fileRows);

  const hunkLines = currentHunk?.lines ?? [];
  const maxLineOffset = Math.max(0, hunkLines.length - hunkRows);
  const clampedLineOffset = Math.min(lineOffset, maxLineOffset);
  const visibleLines = hunkLines.slice(clampedLineOffset, clampedLineOffset + hunkRows);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>
          {title ?? "Review Changes"}
          {files.length > fileRows
            ? ` (files ${fileWindowStart + 1}-${fileWindowStart + visibleFiles.length} of ${files.length})`
            : ""}
        </Text>
        {visibleFiles.map((f, visibleIndex) => {
          const fileIndex = fileWindowStart + visibleIndex;
          const total = f.hunks.length;
          const decided = f.hunks.filter((h) => decisions.has(h.id)).length;
          const marker = f.binary ? "[binary]" : `${decided}/${total} decided`;
          const isCurrentFile = currentRef?.fileIndex === fileIndex;
          return (
            <Text key={f.newPath} color={isCurrentFile ? "cyan" : undefined}>
              {isCurrentFile ? "> " : "  "}
              {f.newPath} ({f.status}) {marker}
            </Text>
          );
        })}
      </Box>
      {currentHunk && currentFile ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          <Text dimColor>
            {currentHunk.header}
            {hunkLines.length > hunkRows
              ? `  [lines ${clampedLineOffset + 1}-${clampedLineOffset + visibleLines.length} of ${hunkLines.length}]`
              : ""}
          </Text>
          {visibleLines.map((line, i) => (
            <Text
              key={clampedLineOffset + i}
              color={line.type === "add" ? "green" : line.type === "remove" ? "red" : undefined}
            >
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              {line.content}
            </Text>
          ))}
          <Text bold color={decisions.get(currentHunk.id) === "approved" ? "green" : decisions.get(currentHunk.id) === "rejected" ? "red" : "yellow"}>
            [{decisions.get(currentHunk.id) ?? "undecided"}]
          </Text>
        </Box>
      ) : (
        <Box borderStyle="round" paddingX={1} marginTop={1}>
          <Text dimColor>
            No reviewable hunks — every file above is binary or empty. Enter
            submits an empty decision list.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {flatHunks.length === 0
            ? "Enter: submit  Esc: cancel"
            : // Kept under 80 columns on purpose: at 80 the longer wording
              // wrapped onto a second line, costing a row of the hunk body
              // this viewport work exists to protect.
              "a/r: approve/reject  ↑/↓: hunk  PgUp/PgDn: scroll  Enter: submit  Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}
