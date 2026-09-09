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
  const rowsArray = (rawRows ?? []) as unknown[];
  const validColumns = rawColumns as TableColumn[];
  // Each row and each cell is checked before anything downstream indexes
  // into it or renders it as a React child. `null`, a non-object, or an
  // array in the `rows` list used to reach `row[col.key]` in view.tsx and
  // throw ("not an object" / "Cannot convert undefined or null to
  // object"-shaped errors); a cell holding an object or array used to reach
  // `<Text>{cell}</Text>` and throw React's "Objects are not valid as a
  // React child". Both crashes happened during render, after this validator
  // would otherwise have already returned successfully, so the check has to
  // live here rather than only shape-checking `rows` as an array. The
  // SKILL.md contract is that "all cell values must be strings" -- callers
  // format numbers and dates themselves -- so a non-string, non-undefined
  // cell (including numbers and booleans, not only objects) is rejected the
  // same as a malformed row.
  for (let i = 0; i < rowsArray.length; i++) {
    const row: unknown = rowsArray[i];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { columns: [], rows: [], error: `table config: rows[${i}] is not an object` };
    }
    for (const col of validColumns) {
      const cell: unknown = (row as Record<string, unknown>)[col.key];
      if (cell !== undefined && typeof cell !== "string") {
        return {
          columns: [],
          rows: [],
          error: `table config: rows[${i}][${JSON.stringify(col.key)}] must be a string`,
        };
      }
    }
  }
  return {
    columns: validColumns,
    rows: rowsArray as Array<Record<string, string>>,
    error: null,
  };
}
