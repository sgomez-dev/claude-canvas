export interface PickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface PickerConfig {
  title?: string;
  prompt?: string;
  /**
   * Required. An absent or unrecognized mode is a config error reported via
   * sendError, not a silent fallback to "single" -- a caller that meant
   * multi-select would otherwise get a single-select canvas with nothing
   * reported anywhere.
   */
  mode: "single" | "multi";
  options: PickerOption[];
}

export interface PickerResult {
  selectedIds: string[];
}
