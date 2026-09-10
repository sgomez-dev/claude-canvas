import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { truncateWithEllipsis, wrappedLineCount } from "../width";
import type { PickerOption, PickerResult } from "./types";

export interface PickerViewProps {
  options: PickerOption[];
  mode: "single" | "multi";
  title?: string;
  prompt?: string;
  /**
   * Total rows this view may paint into; it subtracts its own chrome.
   * Standalone that is the terminal height, and embedded it is whatever the
   * composing canvas allotted the region.
   */
  rows: number;
  /**
   * Terminal width, for estimating whether the footer hint wraps at a
   * narrow width. Optional and defaults to 80 (Ink's own stdout default) so
   * a composing canvas without a meaningful per-region width doesn't have
   * to pass one.
   */
  columns?: number;
  /**
   * Only the focused view receives keys. Ink's `useInput` takes `isActive`
   * for exactly this case -- its own docs call it "useful when there are
   * multiple useInput hooks used at once to avoid handling the same input
   * several times" -- so focus routing needs no dispatch layer of our own.
   */
  focused: boolean;
  onSubmit(result: PickerResult): void;
}

// Rows this view spends on chrome rather than options: two border rows, the
// title, a blank line and the footer hint. The prompt adds one more when
// present.
const CHROME_ROWS = 5;
// Horizontal chrome the outer box spends: one column of border on each side
// plus one column of paddingX on each side.
const HORIZONTAL_CHROME = 4;
const SINGLE_FOOTER_HINT = "↑/↓: navigate  Enter: select  Esc: cancel";
const MULTI_FOOTER_HINT = "↑/↓: navigate  Space: toggle  Enter: submit  Esc: cancel";

function firstEnabledIndex(options: PickerOption[]): number {
  const idx = options.findIndex((o) => !o.disabled);
  return idx === -1 ? 0 : idx;
}

/**
 * The dynamic position-indicator prefix the footer actually renders (e.g.
 * "12-19 of 40  "), or "" when the list fits without windowing at all --
 * exactly mirroring the footer's own render-time condition and computation
 * below, so the row-budget math can measure the string that will actually
 * appear instead of just the static hint.
 */
function positionPrefix(total: number, cursor: number, visibleCount: number): string {
  if (total <= visibleCount) return "";
  const start = Math.floor(cursor / visibleCount) * visibleCount;
  const visibleLen = Math.min(visibleCount, total - start);
  return `${start + 1}-${start + visibleLen} of ${total}  `;
}

/**
 * The picker's rendering and local interaction, knowing nothing about IPC,
 * registry records or outcomes.
 *
 * Deliberately does NOT handle Escape. Cancelling belongs to the canvas
 * shell: a view that swallowed Escape would make a composed canvas
 * un-exitable by keyboard through whichever region happened to be focused,
 * which is the failure every primitive's "Escape must always work" rule
 * exists to prevent.
 *
 * It also does not guard a double submit. `onSubmit` may fire more than
 * once; the shell enforces first-outcome-wins, because the outcome is the
 * shell's to own.
 */
export function PickerView({
  options,
  mode,
  title,
  prompt,
  rows,
  columns = 80,
  focused,
  onSubmit,
}: PickerViewProps): React.JSX.Element {
  // Cursor state and its ref always exist (hooks are unconditional every
  // render — see diff.tsx's identical structure). When `error` is set,
  // `options` is the empty-array fallback from the memo above, so
  // `firstEnabledIndex` safely returns 0 rather than indexing into
  // unvalidated data.
  const [cursor, setCursor] = useState(() => firstEnabledIndex(options));
  // Mirrors `cursor` synchronously into a ref on every render (NOT inside a
  // useEffect, which would reintroduce the same one-render lag this is
  // fixing). useInput's handler is re-registered in a passive effect that
  // lags a state commit by roughly 2-4ms, so reading the closed-over
  // `cursor` directly inside the useInput callback can observe a stale
  // value: two keystrokes arriving within that window (e.g. move then
  // select) could read the PREVIOUS cursor position. Reading from this ref
  // always sees the latest committed cursor regardless of which render's
  // useInput registration is currently active. See diff.tsx's `cursorRef`
  // for the reference implementation of this pattern.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Same stale-closure hazard as cursorRef above, for multi-mode's toggle
  // and submit reads of `checked`.
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  function moveCursor(delta: number) {
    if (options.length === 0) return;
    let next = cursorRef.current;
    for (let attempts = 0; attempts < options.length; attempts++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    // Written directly into the ref here, not left to the render-body
    // mirror alone: two keystrokes with truly zero delay between them (real
    // burst input, not just a fast setTimeout) can both reach this handler
    // before React has committed the render that would otherwise update
    // cursorRef.current. Without this direct write, a second keystroke in
    // the same burst (e.g. Enter right after this "j") would read the ref's
    // stale pre-move value. See the class comment on cursorRef above.
    cursorRef.current = next;
    setCursor(next);
  }

  useInput((input, key) => {
    if (options.length === 0) return;
    if (key.upArrow || input === "k") {
      moveCursor(-1);
    } else if (key.downArrow || input === "j") {
      moveCursor(1);
    } else if (mode === "single" && key.return) {
      const opt = options[cursorRef.current];
      if (opt && !opt.disabled) onSubmit({ selectedIds: [opt.id] });
    } else if (mode === "multi" && input === " ") {
      const opt = options[cursorRef.current];
      if (opt && !opt.disabled) {
        // Same direct-write treatment as cursorRef above: a zero-delay
        // Space immediately followed by Enter must have Enter's read of
        // checkedRef.current see THIS toggle, not a stale pre-toggle set
        // from a render that hasn't committed yet -- otherwise the toggle
        // is lost entirely and Enter submits an empty selection.
        const next = new Set(checkedRef.current);
        if (next.has(opt.id)) next.delete(opt.id);
        else next.add(opt.id);
        checkedRef.current = next;
        setChecked(next);
      }
    } else if (mode === "multi" && key.return) {
      onSubmit({ selectedIds: Array.from(checkedRef.current) });
    }
  }, { isActive: focused });

  // A list longer than the pane used to render every option, overflowing the
  // terminal and pushing the footer hint (and sometimes the cursor itself)
  // out of view -- a picker over a file list or a branch list hits this
  // immediately.
  //
  // The window is derived from the cursor rather than held in state: a
  // separate scrollOffset would need an effect to keep it in sync with the
  // cursor, which costs an extra render per keystroke and can desync from
  // the cursorRef the input handler reads. Paging (rather than centring the
  // cursor) means the list only moves when the cursor crosses a boundary,
  // instead of shifting under the user on every keypress.
  // At a narrow terminal width the footer hint itself wraps onto a second
  // line, which CHROME_ROWS's flat "one line of hint text" assumption
  // doesn't account for -- so reserve however many extra rows the footer's
  // actual wrapped height needs, on top of the fixed chrome.
  //
  // The footer that actually renders is a dynamic position prefix (e.g.
  // "12-19 of 40  ") followed by the static hint -- not the hint alone --
  // and the prefix widens the string enough to push it onto an extra
  // wrapped row the hint-only measurement never accounted for. Measuring
  // just the hint reproduced a real overflow: at both 60 and 70 columns
  // with a long options list, the footer wrapped onto one more row than
  // was reserved for it.
  //
  // The prefix's own width depends on `visibleCount`, which is what this
  // budget calculation produces -- so this runs the estimate twice: once
  // with just the hint to get a candidate `visibleCount`, then measures the
  // ACTUAL footer string that candidate would produce and re-derives
  // `visibleCount` from that. A `visibleCount` that changes between passes
  // by enough to alter the prefix's own digit count is vanishingly rare in
  // practice (it would need to land exactly on a power-of-ten boundary),
  // and even then this is a one-row budget reservation, not a precise
  // layout -- two passes closes the gap the single-pass version had.
  const footerHint = mode === "multi" ? MULTI_FOOTER_HINT : SINGLE_FOOTER_HINT;
  const innerWidth = Math.max(1, columns - HORIZONTAL_CHROME);
  // The prompt is a single, one-time descriptive line rendered above the
  // options -- distinct from the footer, but it can wrap onto multiple rows
  // at a narrow width exactly the same way the footer does. This used to be
  // a flat `(prompt ? 1 : 0)`, which under-reserved whenever the prompt
  // string itself was long enough to wrap -- the same class of overflow the
  // footer was already fixed for, just left unfixed here. Measured with the
  // same `wrappedLineCount` helper as the footer, at the same `innerWidth`.
  const promptRows = prompt ? wrappedLineCount(prompt, innerWidth) : 0;
  let footerRows = wrappedLineCount(footerHint, innerWidth);
  let footerOverflow = Math.max(0, footerRows - 1);
  let visibleCount = Math.max(1, rows - CHROME_ROWS - footerOverflow - promptRows);
  const actualFooter = positionPrefix(options.length, cursor, visibleCount) + footerHint;
  footerRows = wrappedLineCount(actualFooter, innerWidth);
  footerOverflow = Math.max(0, footerRows - 1);
  visibleCount = Math.max(1, rows - CHROME_ROWS - footerOverflow - promptRows);
  const windowStart =
    options.length <= visibleCount ? 0 : Math.floor(cursor / visibleCount) * visibleCount;
  const visibleOptions = options.slice(windowStart, windowStart + visibleCount);
  // Every option row is assumed by the windowing math above to cost exactly
  // one terminal row -- true only if its rendered text never wraps. A long
  // label (a realistic branch name, say) wraps onto 2+ rows at a narrow
  // width, and because this repeats per visible option, one long label
  // silently blows the row budget by however many extra lines it wraps
  // onto (reproduced: 30 options with ~45-char labels, budget 12, 50
  // columns rendered 18 rows). Rather than teach the windowing math to
  // account for a variable per-row height, truncate the row's text to
  // guarantee it always fits in one row -- the same principle
  // table/view.tsx's `fitCell` already applies to cell values, generalized
  // here via `truncateWithEllipsis`. The single-select prefix ("> "/"  ") is
  // 2 columns; multi-select's adds a checkbox ("[x] "/"[ ] "), 4 more.
  const optionPrefixWidth = mode === "multi" ? 6 : 2;
  const optionTextWidth = Math.max(1, innerWidth - optionPrefixWidth);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>{title ?? "Choose"}</Text>
      {prompt ? <Text dimColor>{prompt}</Text> : null}
      {visibleOptions.map((opt, visibleIndex) => {
        const i = windowStart + visibleIndex;
        // The cursor gutter and its colour are gated on `focused`, not just
        // on cursor position: a composed dashboard can mount this view
        // unfocused (another region has the dashboard's focus), and an
        // unfocused view showing a live-looking cursor is indistinguishable
        // from a focused one -- with two pickers in a dashboard, both used
        // to show a highlighted `>` regardless of which one Tab had
        // actually routed keys to. Standalone usage always passes
        // `focused`, so this is a no-op there.
        const isCursor = i === cursor && focused;
        const isChecked = mode === "multi" && checked.has(opt.id);
        // Multi-mode gives the cursor its own gutter (`> `/`  `) ahead of
        // the checkbox so cursor position is visible even with color
        // stripped — previously the cursor was expressed solely via
        // `color="cyan"` on the row, invisible in a no-color terminal.
        // Single mode keeps its existing `> `/`  ` prefix unchanged.
        const prefix =
          mode === "multi"
            ? `${isCursor ? "> " : "  "}${isChecked ? "[x] " : "[ ] "}`
            : isCursor
              ? "> "
              : "  ";
        const rawText = opt.label + (opt.description ? ` — ${opt.description}` : "");
        const text = truncateWithEllipsis(rawText, optionTextWidth);
        return (
          <Text
            key={opt.id}
            color={opt.disabled ? undefined : isCursor ? "cyan" : undefined}
            dimColor={opt.disabled}
          >
            {prefix}
            {text}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {options.length > visibleCount
            ? `${windowStart + 1}-${windowStart + visibleOptions.length} of ${options.length}  `
            : ""}
          {/* Rendered from the same constant the footer budget measures.
              These used to be two separate literals -- the budget measured
              one, the render printed the other -- so editing the visible
              hint silently mismeasured how many rows it would occupy, and
              the wrap reservation would be for a string no longer on
              screen. One source of truth makes that drift impossible. */}
          {footerHint}
        </Text>
      </Box>
    </Box>
  );
}
