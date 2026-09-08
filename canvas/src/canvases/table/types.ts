export interface TableColumn {
  key: string;
  label: string;
  /**
   * Width in characters. Omitted means auto: the longest value actually
   * present in the column, capped at MAX_AUTO_WIDTH. Content beyond the
   * effective width is truncated with an ellipsis, never wrapped --
   * wrapping would break row alignment.
   */
  width?: number;
}

export interface TableConfig {
  title?: string;
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
}
