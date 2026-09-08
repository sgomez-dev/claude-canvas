export interface PickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface PickerConfig {
  title?: string;
  prompt?: string;
  mode: "single" | "multi";
  options: PickerOption[];
}

export interface PickerResult {
  selectedIds: string[];
}
