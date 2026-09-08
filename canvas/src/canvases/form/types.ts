export type FormField =
  | { id: string; type: "text"; label: string; placeholder?: string; required?: boolean }
  | { id: string; type: "textarea"; label: string; placeholder?: string; required?: boolean }
  | {
      id: string;
      type: "select";
      label: string;
      options: Array<{ value: string; label: string }>;
      required?: boolean;
    }
  | { id: string; type: "checkbox"; label: string }
  | { id: string; type: "number"; label: string; min?: number; max?: number; required?: boolean };

export interface FormConfig {
  title?: string;
  fields: FormField[];
}

export interface FormResult {
  values: Record<string, string | number | boolean>;
}
