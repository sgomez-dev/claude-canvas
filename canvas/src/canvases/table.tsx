import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { TableConfig, TableColumn } from "./table/types";
import { displayWidth, padToWidth, truncateToWidth } from "./width";

export interface TableProps {
  id: string;
  config?: TableConfig;
  scenario?: string;
  enabled: boolean;
}

const MAX_AUTO_WIDTH = 40;
// Rows this component spends on chrome rather than data: two border rows,
// the title, the column header, a blank line, and the footer hint.
const HEADER_OVERHEAD_ROWS = 6;

interface ValidatedTable {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  error: string | null;
}

// Validates the raw config before anything indexes into it, the same
// posture picker.tsx and form.tsx take. `table` has no result type, so a
// malformed config here cannot corrupt an answer -- but it can render a
// frame that looks like a bug, which the spec explicitly rules out ("an
// empty table must never look like a bug"), and a table with rows but no
// columns renders as nothing at all.
function validateTable(config: TableConfig | undefined): ValidatedTable {
  const rawColumns: unknown = config?.columns;
  if (!Array.isArray(rawColumns)) {
    return { columns: [], rows: [], error: "table config: 'columns' must be an array" };
  }
  if (rawColumns.length === 0) {
    return { columns: [], rows: [], error: "table config: 'columns' must not be empty" };
  }
  const seen = new Set<string>();
  for (let i = 0; i < rawColumns.length; i++) {
    const c: unknown = rawColumns[i];
    const key = c !== null && typeof c === "object" ? (c as { key?: unknown }).key : undefined;
    const label = c !== null && typeof c === "object" ? (c as { label?: unknown }).label : undefined;
    if (typeof key !== "string" || key.length === 0) {
      return { columns: [], rows: [], error: `table config: columns[${i}] is missing 'key'` };
    }
    if (typeof label !== "string") {
      return { columns: [], rows: [], error: `table config: column ${JSON.stringify(key)} is missing 'label'` };
    }
    if (seen.has(key)) {
      // Two columns sharing a key would render the same cell twice and give
      // React duplicate keys for sibling <Text> elements.
      return { columns: [], rows: [], error: `table config: duplicate column key ${JSON.stringify(key)}` };
    }
    seen.add(key);
    const width: unknown = (c as { width?: unknown }).width;
    if (width !== undefined && (typeof width !== "number" || !Number.isInteger(width) || width < 1)) {
      return {
        columns: [],
        rows: [],
        error: `table config: column ${JSON.stringify(key)} has an invalid 'width' (must be an integer >= 1)`,
      };
    }
  }
  const rawRows: unknown = config?.rows;
  if (rawRows !== undefined && !Array.isArray(rawRows)) {
    return { columns: [], rows: [], error: "table config: 'rows' must be an array" };
  }
  return {
    columns: rawColumns as TableColumn[],
    rows: (rawRows ?? []) as Array<Record<string, string>>,
    error: null,
  };
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

export function Table({ id, config: initialConfig, scenario = "display", enabled }: TableProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Live config: replaced by an `update` pushed from the controller. This is
  // the primitive most likely to receive one -- refreshing a table's rows in
  // place is the obvious use for server-push.
  const [config, setConfig] = useState<TableConfig | undefined>(initialConfig);

  const { columns, rows, error } = useMemo<ValidatedTable>(() => validateTable(config), [config]);

  const widths = useMemo(() => columns.map((c) => computeWidth(c, rows)), [columns, rows]);

  const totalTerminalRows = stdout?.rows ?? 24;
  const visibleCount = Math.max(1, totalTerminalRows - HEADER_OVERHEAD_ROWS);

  const [scrollOffset, setScrollOffset] = useState(0);
  const maxOffset = Math.max(0, rows.length - visibleCount);

  // Guards against a second `cancelled` firing before the component has
  // actually unmounted. Same pattern as picker.tsx, diff.tsx and form.tsx.
  const submittedRef = useRef(false);

  const ipc = useCanvasServer({
    id,
    kind: "table",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => setConfig(next as TableConfig),
  });

  // A pushed config is a new question, so the interaction state that
  // referred to the old one is dropped rather than carried over: a cursor
  // can point past the new content, and a selection or decision can name
  // something that no longer exists. Skipped on the first run, where the
  // state initializers already hold the right values.
  const generation = useRef(0);
  useEffect(() => {
    if (generation.current++ === 0) return;
    setScrollOffset(0);
    sentRef.current = false;
  }, [rows]);

  // Reports a config error to the controller exactly once, gated on
  // ipc.isConnected because the server starts asynchronously. See
  // picker.tsx's equivalent effect for the full reasoning.
  const sentRef = useRef(false);
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  useInput((input, key) => {
    // Escape first and unconditionally, in every state, so the pane is
    // never un-exitable by keyboard.
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      // `table` is view-only by design: there is no "selected" outcome, so
      // closing always reports cancelled. Row selection composes with
      // `picker` rather than living here.
      ipc.sendCancelled("escape");
      exit();
      return;
    }
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
  });

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (rows.length === 0) {
    // An explicit state, distinguishable from a blank screen: the spec is
    // clear that "an empty table must never look like a bug".
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold>{config?.title ?? "Table"}</Text>
        <Text dimColor>No data.</Text>
      </Box>
    );
  }

  const visibleRows = rows.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Table"}</Text>
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
