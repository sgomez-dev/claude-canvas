import type { FormConfig, FormField } from "./types";

const FIELD_TYPES = ["text", "textarea", "select", "checkbox", "number"] as const;

interface ValidatedForm {
  fields: FormField[];
  error: string | null;
}

// Validates the *raw* config before anything indexes into it, mirroring
// picker.tsx's combined `{options, mode, error}` memo. The spec is explicit
// that a `select` field with an empty `options` array is a config error
// reported via sendError, "the same posture as picker's empty-list case,
// since a select is structurally a picker embedded in a field" -- and an
// unreported config error is the worst outcome here: the canvas opens, the
// controller's `wait` blocks for its full 55 s, and the reply is a bare
// "pending" that says nothing about what was wrong.
//
// Lifted out of form.tsx unchanged so the canvas shell and any canvas
// embedding the form view treat a bad config identically.
export function validateForm(config: FormConfig | undefined): ValidatedForm {
  const raw: unknown = config?.fields;
  if (!Array.isArray(raw)) {
    return { fields: [], error: "form config: 'fields' must be an array" };
  }
  if (raw.length === 0) {
    return { fields: [], error: "form config: 'fields' must not be empty" };
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const f: unknown = raw[i];
    if (f === null || typeof f !== "object") {
      return { fields: [], error: `form config: fields[${i}] is not an object` };
    }
    const { id, label, type } = f as { id?: unknown; label?: unknown; type?: unknown };
    if (typeof id !== "string" || id.length === 0) {
      return { fields: [], error: `form config: fields[${i}] is missing 'id'` };
    }
    if (typeof label !== "string" || label.length === 0) {
      return { fields: [], error: `form config: field ${JSON.stringify(id)} is missing 'label'` };
    }
    if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) {
      return {
        fields: [],
        error:
          `form config: field ${JSON.stringify(id)} has unsupported type ${JSON.stringify(type)}. ` +
          `Expected one of: ${FIELD_TYPES.join(", ")}.`,
      };
    }
    if (seen.has(id)) {
      // Two fields sharing an id would collide in the `values` record, so
      // one would silently overwrite the other's answer.
      return { fields: [], error: `form config: duplicate field id ${JSON.stringify(id)}` };
    }
    seen.add(id);
    if (type === "select") {
      const options: unknown = (f as { options?: unknown }).options;
      if (!Array.isArray(options) || options.length === 0) {
        return {
          fields: [],
          error: `form config: select field ${JSON.stringify(id)} needs a non-empty 'options' array`,
        };
      }
      for (let j = 0; j < options.length; j++) {
        const o: unknown = options[j];
        const value = o !== null && typeof o === "object" ? (o as { value?: unknown }).value : undefined;
        const optLabel = o !== null && typeof o === "object" ? (o as { label?: unknown }).label : undefined;
        if (typeof value !== "string" || typeof optLabel !== "string") {
          return {
            fields: [],
            error: `form config: select field ${JSON.stringify(id)} options[${j}] needs string 'value' and 'label'`,
          };
        }
      }
    }
  }
  return { fields: raw as FormField[], error: null };
}
