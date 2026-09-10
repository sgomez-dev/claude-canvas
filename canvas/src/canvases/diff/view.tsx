import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth, truncateWithEllipsis, wrappedLineCount } from "../width";
import type { DiffFile, DiffReviewResult, HunkDecision } from "./types";

export interface DiffViewProps {
  files: DiffFile[];
  title?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  /**
   * Terminal width, for estimating whether the footer hint wraps at a
   * narrow width. Optional and defaults to 80 (Ink's own stdout default)
   * so a composing canvas that doesn't have a meaningful per-region width
   * (dashboard.tsx stacks regions at full terminal width) doesn't have to
   * pass one.
   */
  columns?: number;
  focused: boolean;
  onSubmit(result: DiffReviewResult): void;
}

interface FlatHunkRef {
  fileIndex: number;
  hunkIndex: number;
}

// Rows this component spends on chrome rather than content: the file-list
// box's two borders and title (3), the blank margin row between the
// file-list box and the hunk box (1), the hunk box's two borders plus its
// header and decision lines (4), and the footer's blank margin row plus one
// line of hint text (2). 3+1+4+2 = 10. This used to be 9, missing the
// margin row between the two boxes -- which meant the rendered frame was
// always exactly one row taller than the terminal, and because Ink switches
// to a full clear-and-redraw once the frame reaches the terminal's row
// count, that off-by-one permanently scrolled the top line of the frame
// away on every single render.
const CHROME_ROWS = 10;
// The file list never takes more than this, so a 40-file diff cannot starve
// the hunk body it exists to help you read.
const MAX_FILE_ROWS = 5;
// Horizontal chrome the footer's own row spends. Unlike picker/form/table,
// diff's footer sits in the outermost, UNBORDERED, unpadded column Box --
// the border and paddingX belong only to the file-list and hunk boxes
// nested inside it -- so the footer's available width is the full terminal
// width, not `columns` minus a border-and-padding allowance.
const HORIZONTAL_CHROME = 0;
// Unlike the footer, the file-list and hunk boxes each DO have their own
// border and paddingX -- one column of each side, same as picker/form/table.
const NESTED_HORIZONTAL_CHROME = 4;
// Kept under 80 columns on purpose: at 80 the longer wording wrapped onto a
// second line, costing a row of the hunk body the viewport exists to protect.
const FOOTER_HINT =
  "a/r: approve/reject  ↑/↓: hunk  PgUp/PgDn: scroll  Enter: submit  Esc: cancel";
// What renders when there is nothing to decide -- a binary-only diff. The
// budget below measures whichever of the two will actually appear: measuring
// the long one while rendering the short one over-reserved a row.
const NO_HUNKS_FOOTER_HINT = "Enter: submit  Esc: cancel";

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
  columns = 80,
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
  // The valid maximum for `lineOffset`, mirrored into a ref every render
  // (same pattern as cursorRef) so the PageUp/PageDown handlers below can
  // clamp INSIDE the setter rather than only at render time. Without this,
  // repeatedly pressing PageDown past the end of the content let the stored
  // offset keep growing past the valid maximum -- the render clamped what
  // was DISPLAYED, but the internal value kept climbing, so the first
  // several PageUp presses afterward appeared to do nothing while the value
  // came back down through the overshot range.
  //
  // That render-body mirror alone has the exact same stale-ref bug this
  // whole class of ref was invented to fix: it is only WRITTEN in the
  // render body (below, alongside hunkRowsRef), but it IS read inside the
  // useInput handler's PageDown branch. A zero-delay "j"/"k" (move to a
  // different hunk, whose max scroll differs from the previous hunk's)
  // immediately followed by PageDown -- no settle, no await between them --
  // reaches the handler before the render that would refresh
  // maxLineOffsetRef.current for the NEW hunk has committed, so PageDown
  // clamps against the PREVIOUS hunk's maximum instead, silently swallowing
  // or mis-clamping the scroll. Fixed the same way as cursorRef/
  // decisionsRef/focusIndexRef/valuesRef elsewhere in this codebase: the
  // cursor-move branches below also write maxLineOffsetRef.current directly,
  // computed from hunkRowsRef (a plain render-body mirror is fine there --
  // hunkRows is derived only from props/terminal size, never decided by this
  // handler itself, so it cannot go stale within a single keystroke burst).
  const maxLineOffsetRef = useRef(0);
  const hunkRowsRef = useRef(1);

  function maxLineOffsetForHunk(flatIndex: number): number {
    const ref = flatHunks[flatIndex];
    const hunk = ref ? files[ref.fileIndex]?.hunks[ref.hunkIndex] : undefined;
    const lineCount = hunk?.lines.length ?? 0;
    return Math.max(0, lineCount - hunkRowsRef.current);
  }

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
      setLineOffset((o) => Math.min(maxLineOffsetRef.current, o + 1));
      return;
    }
    if (key.pageUp) {
      setLineOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.upArrow || input === "k") {
      // Written directly into the ref here, not left to the render-body
      // mirror alone: two keystrokes with truly zero delay between them
      // (real burst input, not just a fast setTimeout) can both reach this
      // handler before React has committed the render that would otherwise
      // update cursorRef.current. Without this direct write, a second
      // keystroke in the same burst (e.g. "a" right after this "j") would
      // read the ref's stale pre-move value. See the class comment on
      // cursorRef above.
      const next = Math.max(0, cursorRef.current - 1);
      cursorRef.current = next;
      setCursor(next);
      setLineOffset(0);
      // Direct ref write, same reasoning as cursorRef above: a zero-delay
      // "k" (switch to this hunk) immediately followed by PageDown must
      // have PageDown's clamp read THIS hunk's max scroll, not the
      // previous hunk's stale value. See the class comment on
      // maxLineOffsetRef above.
      maxLineOffsetRef.current = maxLineOffsetForHunk(next);
    } else if (key.downArrow || input === "j") {
      const next = Math.min(flatHunks.length - 1, cursorRef.current + 1);
      cursorRef.current = next;
      setCursor(next);
      setLineOffset(0);
      maxLineOffsetRef.current = maxLineOffsetForHunk(next);
    } else if (input === "a") {
      const ref = flatHunks[cursorRef.current];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        // Same direct-write treatment as cursorRef above: a zero-delay "a"
        // immediately followed by Enter must have Enter's read of
        // decisionsRef.current see THIS decision, not a stale pre-approval
        // map from a render that hasn't committed yet.
        const nextDecisions = new Map(decisionsRef.current).set(hunk.id, "approved");
        decisionsRef.current = nextDecisions;
        setDecisions(nextDecisions);
      }
    } else if (input === "r") {
      const ref = flatHunks[cursorRef.current];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        const nextDecisions = new Map(decisionsRef.current).set(hunk.id, "rejected");
        decisionsRef.current = nextDecisions;
        setDecisions(nextDecisions);
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
  //
  // At a narrow terminal width the footer hint itself wraps onto a second
  // (or third) line, which CHROME_ROWS's flat "one line of hint text"
  // assumption doesn't account for -- so on top of the fixed chrome, reserve
  // however many extra rows the footer's actual wrapped height needs.
  const footerHint = flatHunks.length === 0 ? NO_HUNKS_FOOTER_HINT : FOOTER_HINT;
  const footerRows = wrappedLineCount(footerHint, Math.max(1, columns - HORIZONTAL_CHROME));
  const footerOverflow = Math.max(0, footerRows - 1);
  const budget = Math.max(2, totalBudget - CHROME_ROWS - footerOverflow);
  const fileRows = Math.max(1, Math.min(MAX_FILE_ROWS, files.length, budget - 1));
  const hunkRows = Math.max(1, budget - fileRows);
  // Render-body mirror only, and that's sufficient: unlike maxLineOffsetRef,
  // this value is derived purely from props/terminal size, never decided by
  // the useInput handler itself, so it cannot be stale relative to anything
  // the handler just did within the same keystroke burst.
  hunkRowsRef.current = hunkRows;

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
  // Mirrors the render's own `maxLineOffset` into the ref the PageDown
  // handler clamps against, same pattern as cursorRef.
  maxLineOffsetRef.current = maxLineOffset;
  const clampedLineOffset = Math.min(lineOffset, maxLineOffset);
  const visibleLines = hunkLines.slice(clampedLineOffset, clampedLineOffset + hunkRows);

  // Both the file-list box and the hunk box assume every entry/header they
  // render costs exactly one terminal row -- true only if the text never
  // wraps. A long file path or hunk header (realistic ones routinely run
  // past 80 columns) wraps onto 2+ rows at a narrow width, and for the file
  // list this repeats per visible file, so it can blow the row budget the
  // same way a long picker option or tree label does. Truncated here
  // instead, same principle as table's `fitCell`: each box's inner width is
  // `columns - NESTED_HORIZONTAL_CHROME` (its own border + paddingX), and
  // whatever fixed prefix/suffix that row already renders is subtracted
  // before truncating the free text.
  const nestedInnerWidth = Math.max(1, columns - NESTED_HORIZONTAL_CHROME);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
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
          // Gated on `focused` as well as cursor position, same reasoning
          // as picker/view.tsx's isCursor: a composed dashboard can mount
          // this view unfocused, and the file cursor must not keep showing
          // as live in that state.
          const isCurrentFile = currentRef?.fileIndex === fileIndex && focused;
          // The cursor gutter ("> "/"  ", 2 columns) is fixed; the rest --
          // path, status and decision marker -- is what gets truncated, as
          // one unit, so a long path is cut rather than the whole line
          // wrapping.
          const rawEntry = `${f.newPath} (${f.status}) ${marker}`;
          const entryBudget = Math.max(1, nestedInnerWidth - 2);
          const entryText = truncateWithEllipsis(rawEntry, entryBudget);
          return (
            <Text key={f.newPath} color={isCurrentFile ? "cyan" : undefined}>
              {isCurrentFile ? "> " : "  "}
              {entryText}
            </Text>
          );
        })}
      </Box>
      {currentHunk && currentFile ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          {(() => {
            const suffix =
              hunkLines.length > hunkRows
                ? `  [lines ${clampedLineOffset + 1}-${clampedLineOffset + visibleLines.length} of ${hunkLines.length}]`
                : "";
            const headerBudget = Math.max(1, nestedInnerWidth - displayWidth(suffix));
            const header = truncateWithEllipsis(currentHunk.header, headerBudget);
            return (
              <Text dimColor>
                {header}
                {suffix}
              </Text>
            );
          })()}
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
            ? NO_HUNKS_FOOTER_HINT
            : FOOTER_HINT}
        </Text>
      </Box>
    </Box>
  );
}
