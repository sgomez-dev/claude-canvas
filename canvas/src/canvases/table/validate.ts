import type { TableColumn, TableConfig } from "./types";

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
export function validateTable(config: TableConfig | undefined): ValidatedTable {
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
