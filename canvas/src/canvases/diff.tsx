import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { parseUnifiedDiff, DiffParseError } from "./diff/parser";
import type { DiffFile, DiffReviewConfig, DiffReviewResult, HunkDecision } from "./diff/types";

export interface DiffProps {
  id: string;
  config?: DiffReviewConfig;
  scenario?: string;
  enabled: boolean;
}

interface FlatHunkRef {
  fileIndex: number;
  hunkIndex: number;
}

interface ParsedDiff {
  files: DiffFile[];
  error: string | null;
}

// Rows this component spends on chrome rather than content: the file-list
// box's two borders and title, the hunk box's two borders plus its header
// and decision lines, and the footer's blank line plus hint.
const CHROME_ROWS = 9;
// The file list never takes more than this, so a 40-file diff cannot starve
// the hunk body it exists to help you read.
const MAX_FILE_ROWS = 5;

export function Diff({ id, config: initialConfig, scenario = "review", enabled }: DiffProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Live config: replaced by an `update` pushed from the controller.
  const [config, setConfig] = useState<DiffReviewConfig | undefined>(initialConfig);

  // Files and any parse error are derived from ONE memo so there is a single
  // source of truth for "did parsing fail". Previously `parseError` was set
  // via setState as a side effect INSIDE this memo's try/catch — a
  // render-phase side effect that only happened to be safe because
  // `config.diffText` never changes for the component's lifetime. Deriving
  // both values together removes that fragile assumption entirely.
  const { files, error } = useMemo<ParsedDiff>(() => {
    if (!config?.diffText || config.diffText.trim().length === 0) {
      return { files: [], error: null };
    }
    try {
      return { files: parseUnifiedDiff(config.diffText), error: null };
    } catch (e) {
      return { files: [], error: e instanceof DiffParseError ? e.message : "Failed to parse diff." };
    }
  }, [config?.diffText]);

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

  // Guards against a second outcome message (Enter-then-Enter, or
  // Enter-then-Escape) firing in quick succession before the component has
  // actually unmounted.
  const submittedRef = useRef(false);

  const ipc = useCanvasServer({
    id,
    kind: "diff",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => setConfig(next as DiffReviewConfig),
  });

  // A pushed config is a new question, so the interaction state that
  // referred to the old one is dropped rather than carried over: a cursor
  // can point past the new content, and a selection or decision can name
  // something that no longer exists. Skipped on the first run, where the
  // state initializers already hold the right values.
  // Decisions in particular MUST be dropped: they are keyed by hunk id, and
  // a hunk id from the previous diff can collide with an unrelated hunk in
  // the new one, which would silently apply a decision to code the user
  // never saw.
  const generation = useRef(0);
  useEffect(() => {
    if (generation.current++ === 0) return;
    setCursor(0);
    setLineOffset(0);
    setDecisions(new Map());
    sentRef.current = false;
  }, [files]);

  // Reports a parse failure to the controller exactly once, when `error`
  // transitions from null to non-null. Gated on `ipc.isConnected`: the IPC
  // server starts asynchronously (real filesystem I/O for the registry
  // record), so an unconditional send on mount would race the server's
  // startup and broadcast to zero connections, silently dropping the
  // message forever (the same underlying reason the `ready` message is
  // "broadcast the instant the server comes up" and not reliably
  // observable). This effect re-runs when `isConnected` flips to true and
  // sends then; `sentRef` keeps that to a single send even if this effect
  // re-runs again afterward.
  const sentRef = useRef(false);
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  useInput((input, key) => {
    // Escape must always work, in every state (parse error, empty diff,
    // normal review) — checked first and unconditionally so the pane is
    // never un-exitable by keyboard.
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (key.return) {
      // Submits even when there are no hunks, as long as the diff had files
      // -- a binary-only diff has nothing to approve, and reporting an empty
      // decision list ("reviewed, nothing to apply") is information, whereas
      // forcing the user to Escape reports `cancelled` and loses the
      // distinction between that and bailing out.
      if (files.length === 0) return;
      if (submittedRef.current) return;
      submittedRef.current = true;
      const result: DiffReviewResult = {
        decisions: flatHunks.map((ref) => {
          const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
          return { hunkId: hunk.id, decision: decisionsRef.current.get(hunk.id) ?? "rejected" };
        }),
      };
      ipc.sendSelected(result);
      exit();
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
  });

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">Failed to parse diff: {error}</Text>
      </Box>
    );
  }

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
  const budget = Math.max(2, (stdout?.rows ?? 24) - CHROME_ROWS);
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
          {config?.title ?? "Review Changes"}
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
