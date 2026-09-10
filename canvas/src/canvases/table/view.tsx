import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth, padToWidth, truncateToWidth, wrappedLineCount } from "../width";
import type { TableColumn } from "./types";

export interface TableViewProps {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  title?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  /**
   * Terminal width, for estimating whether the footer hint wraps at a
   * narrow width. Named `terminalWidth` rather than `columns` because that
   * name is already taken by the table's own column definitions above.
   * Optional and defaults to 80 (Ink's own stdout default) so a composing
   * canvas without a meaningful per-region width doesn't have to pass one.
   */
  terminalWidth?: number;
  focused: boolean;
}

const MAX_AUTO_WIDTH = 40;
// Rows this component spends on chrome rather than data: two border rows,
// the title, the column header, a blank line, and the footer hint.
const HEADER_OVERHEAD_ROWS = 6;
// Horizontal chrome the outer box spends: one column of border on each side
// plus one column of paddingX on each side.
const HORIZONTAL_CHROME = 4;
const FOOTER_HINT = "↑/↓/PgUp/PgDn: scroll  Esc: close";

/**
 * The dynamic position-indicator prefix the footer actually renders (e.g.
 * "rows 12-19 of 40  "), or "" when every row fits without scrolling at all
 * -- exactly mirroring the footer's own render-time condition and
 * computation below, so the row-budget math can measure the string that
 * will actually appear instead of just the static hint.
 */
function positionPrefix(total: number, scrollOffset: number, visibleCount: number): string {
  if (total <= visibleCount) return "";
  const visibleLen = Math.min(visibleCount, total - scrollOffset);
  return `rows ${scrollOffset + 1}-${scrollOffset + visibleLen} of ${total}  `;
}

function computeWidth(col: TableColumn, rows: Array<Record<string, string>>): number {
  if (col.width !== undefined) return col.width;
  let longest = displayWidth(col.label);
  for (const row of rows) {
    const cell = displayWidth(row[col.key] ?? "");
    if (cell > longest) longest = cell;
  }
  return Math.max(1, Math.min(MAX_AUTO_WIDTH, longest));
}

/**
 * MAX_AUTO_WIDTH caps any ONE auto-sized column, but nothing capped the SUM
 * of every column's width against the actual terminal -- an explicit
 * `width` is never capped at all, and even auto-sized columns can add up
 * past the terminal once there are enough of them (six columns at the
 * 40-column auto-cap is already 240, comfortably wider than most terminals).
 * The header row and every data row repeat the same column widths, so this
 * is the identical "one row assumed, more than one row rendered" overflow
 * fitCell already exists to prevent for a single cell -- just triggered by
 * the ROW'S total width instead of any individual cell's. Reproduced: 6
 * columns of width 20 in a 40-column terminal (36-column inner width)
 * rendered the header and every data row wrapped onto 2 physical lines
 * instead of 1.
 *
 * Shrinks every column proportionally down to `budget` display columns
 * total, flooring each at 1 (a column narrower than that cannot render at
 * all), then hands out whatever's left over one column at a time -- widest
 * original column first, since that's where the most content is being cut
 * and where an extra column back is most useful -- until the total matches
 * exactly. If `budget` is itself smaller than one column per column (more
 * columns than available width), every column is already floored at 1 and
 * the row still overflows -- an unavoidable floor, not a bug this can
 * paper over.
 */
function shrinkWidthsToFit(widths: number[], budget: number): number[] {
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= budget || widths.length === 0) return widths;
  const scale = budget / total;
  const shrunk = widths.map((w) => Math.max(1, Math.floor(w * scale)));
  let used = shrunk.reduce((sum, w) => sum + w, 0);
  let leftover = budget - used;
  if (leftover > 0) {
    const byOriginalWidthDesc = widths
      .map((w, i) => ({ i, w }))
      .sort((a, b) => b.w - a.w);
    for (const { i } of byOriginalWidthDesc) {
      if (leftover <= 0) break;
      if (shrunk[i]! < widths[i]!) {
        shrunk[i]! += 1;
        leftover -= 1;
      }
    }
  }
  return shrunk;
}

// Measured in display columns, not UTF-16 code units. `.length` was wrong
// three ways -- a CJK ideograph is one code unit and two columns, an astral
// emoji is two units and two columns, and a ZWJ family emoji is eleven
// units and two columns -- so any row containing one misaligned. See
// width.ts; no dependency was needed, only Intl.Segmenter.
function fitCell(content: string, width: number): string {
  if (displayWidth(content) > width) {
    if (width <= 1) return truncateToWidth(content, width);
    // Truncate to leave room for the ellipsis, then pad: a double-width
    // character dropped at the boundary can leave the result a column
    // short of `width - 1`.
    return padToWidth(truncateToWidth(content, width - 1) + "…", width);
  }
  return padToWidth(content, width);
}

/**
 * The table's rendering and scrolling, knowing nothing about IPC or
 * outcomes.
 *
 * View-only by design, so unlike every other view it takes no `onSubmit` at
 * all: there is no "selected" outcome for a table, and row selection
 * composes with the picker rather than living here.
 *
 * Escape belongs to the canvas shell -- see picker/view.tsx for why a view
 * must never swallow it.
 */
export function TableView({
  columns,
  rows,
  title,
  budget,
  terminalWidth = 80,
  focused,
}: TableViewProps): React.JSX.Element {
  // Computed here (rather than down where the footer's own innerWidth used
  // to be the only consumer) because the column-width cap below needs it
  // too, and both must measure the identical inner width the row actually
  // renders into.
  const innerWidth = Math.max(1, terminalWidth - HORIZONTAL_CHROME);
  const widths = useMemo(() => {
    const raw = columns.map((c) => computeWidth(c, rows));
    // Each column's cell is followed by one trailing space (see the header
    // and body rows below), so the row costs `raw.length` columns beyond
    // the widths themselves.
    const budget = Math.max(columns.length, innerWidth - columns.length);
    return shrinkWidthsToFit(raw, budget);
  }, [columns, rows, innerWidth]);

  // Audited against the same stale-ref-in-useInput bug class fixed in
  // diff/view.tsx, picker/view.tsx and form/view.tsx (see their cursorRef/
  // checkedRef/focusIndexRef/valuesRef comments): unlike those, `scrollOffset`
  // here is never mirrored into a ref and read back inside the useInput
  // handler -- every handler below reads it exclusively through
  // `setScrollOffset`'s own functional updater (`(o) => ...`), whose `o`
  // React guarantees is the latest queued value regardless of render/effect
  // timing. So there is nothing here for two zero-delay keystrokes to race.
  //
  // That guarantee covers WRITES only, and is not a reason a value never
  // needs the ref treatment -- it was previously (and wrongly) cited here to
  // justify form.tsx's `values` skipping it too. form.tsx's bug was never in
  // how `values` was written (its updater form is exactly as safe as
  // `scrollOffset`'s); it was that `values` also needed to be READ outside
  // of any setState updater -- in `attemptSubmit`, to build the submitted
  // payload, and in `isMissing`, to validate it -- and a value read that way
  // has no updater to guarantee freshness. Reading it from a mirror ref that
  // was only ever written in the render body (not directly at each handler
  // call site) left exactly the same one-render-lag window the cursorRef/
  // checkedRef/focusIndexRef comments describe. `scrollOffset` here has no
  // equivalent read site -- nothing outside a `setScrollOffset` updater ever
  // reads it inside the handler -- which is the actual reason it is safe
  // without a ref, not because its writes are functional updates.
  const [scrollOffset, setScrollOffset] = useState(0);

  // At a narrow terminal width the footer hint itself wraps onto a second
  // line, which HEADER_OVERHEAD_ROWS's flat "one line of hint text"
  // assumption doesn't account for -- so reserve however many extra rows
  // the footer's actual wrapped height needs, on top of the fixed chrome.
  //
  // The footer that actually renders is a dynamic position prefix (e.g.
  // "rows 12-19 of 40  ") followed by the static hint -- not the hint alone
  // -- and the prefix widens the string enough to push it onto an extra
  // wrapped row the hint-only measurement never accounted for. Reproduced:
  // the table overflowed its terminal by one row at 50 columns with many
  // rows. The prefix's own width depends on `visibleCount`, which is what
  // this budget calculation produces, so this runs the estimate twice: once
  // with just the hint to get a candidate `visibleCount`, then measures the
  // ACTUAL footer string that candidate (and the current `scrollOffset`)
  // would produce and re-derives `visibleCount` from that. See
  // picker/view.tsx's identical two-pass treatment for why one extra pass
  // is enough in practice.
  let footerRows = wrappedLineCount(FOOTER_HINT, innerWidth);
  let footerOverflow = Math.max(0, footerRows - 1);
  let visibleCount = Math.max(1, budget - HEADER_OVERHEAD_ROWS - footerOverflow);
  const actualFooter = positionPrefix(rows.length, scrollOffset, visibleCount) + FOOTER_HINT;
  footerRows = wrappedLineCount(actualFooter, innerWidth);
  footerOverflow = Math.max(0, footerRows - 1);
  visibleCount = Math.max(1, budget - HEADER_OVERHEAD_ROWS - footerOverflow);

  const maxOffset = Math.max(0, rows.length - visibleCount);

  useInput((input, key) => {
    // j/k mirror the arrow keys, matching picker.tsx and diff.tsx.
    if (key.downArrow || input === "j") {
      setScrollOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.upArrow || input === "k") {
      setScrollOffset((o) => Math.max(0, o - 1));
    } else if (key.pageDown) {
      setScrollOffset((o) => Math.min(maxOffset, o + visibleCount));
    } else if (key.pageUp) {
      setScrollOffset((o) => Math.max(0, o - visibleCount));
    }
  }, { isActive: focused });

  if (rows.length === 0) {
    // An explicit state, distinguishable from a blank screen: the spec is
    // clear that "an empty table must never look like a bug".
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold>{title ?? "Table"}</Text>
        <Text dimColor>No data.</Text>
      </Box>
    );
  }

  const visibleRows = rows.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      {/* Unlike picker/form/diff/tree, a table has no cursor row of its
          own -- it only scrolls -- so there is no existing per-row marker
          to gate on `focused`. Without some textual signal here, two
          tables composed in one dashboard would be indistinguishable after
          Tab moved focus between them once colour is stripped (NO_COLOR, a
          screen reader, piped output). Rather than add a permanent prefix
          to every table's title (which would change the standalone `table`
          canvas's own rendering, since it always passes `focused`), this
          only adds text in the state that previously had NO visual
          signal at all: not focused. Focused keeps the title exactly as
          before. */}
      <Text bold>
        {title ?? "Table"}
        {focused ? "" : "  (not focused)"}
      </Text>
      {/* The header sits outside the scrolled slice, so it stays put while
          the body moves. */}
      <Box>
        {columns.map((c, i) => (
          <Text key={c.key} bold>
            {fitCell(c.label, widths[i]!)}{" "}
          </Text>
        ))}
      </Box>
      {visibleRows.map((row, rowIndex) => (
        <Box key={scrollOffset + rowIndex}>
          {columns.map((c, i) => (
            <Text key={c.key}>
              {fitCell(row[c.key] ?? "", widths[i]!)}{" "}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          {rows.length > visibleCount
            ? `rows ${scrollOffset + 1}-${scrollOffset + visibleRows.length} of ${rows.length}  `
            : ""}
          {/* Rendered from the same constant the footer budget measures.
              These used to be two separate literals -- the budget measured
              one, the render printed the other -- so editing the visible
              hint silently mismeasured how many rows it would occupy, and
              the wrap reservation would be for a string no longer on
              screen. One source of truth makes that drift impossible. */}
          {FOOTER_HINT}
        </Text>
      </Box>
    </Box>
  );
}
