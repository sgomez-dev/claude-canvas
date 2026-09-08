import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth, padToWidth, truncateToWidth } from "../width";
import type { TableColumn } from "./types";

export interface TableViewProps {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  title?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  focused: boolean;
}

const MAX_AUTO_WIDTH = 40;
// Rows this component spends on chrome rather than data: two border rows,
// the title, the column header, a blank line, and the footer hint.
const HEADER_OVERHEAD_ROWS = 6;

function computeWidth(col: TableColumn, rows: Array<Record<string, string>>): number {
  if (col.width !== undefined) return col.width;
  let longest = displayWidth(col.label);
  for (const row of rows) {
    const cell = displayWidth(row[col.key] ?? "");
    if (cell > longest) longest = cell;
  }
  return Math.max(1, Math.min(MAX_AUTO_WIDTH, longest));
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
  focused,
}: TableViewProps): React.JSX.Element {
  const widths = useMemo(() => columns.map((c) => computeWidth(c, rows)), [columns, rows]);

  const visibleCount = Math.max(1, budget - HEADER_OVERHEAD_ROWS);

  const [scrollOffset, setScrollOffset] = useState(0);
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title ?? "Table"}</Text>
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
          ↑/↓/PgUp/PgDn: scroll  Esc: close
        </Text>
      </Box>
    </Box>
  );
}
