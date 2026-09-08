import type { PickerConfig, PickerOption } from "./types";

export interface ValidatedPicker {
  options: PickerOption[];
  mode: "single" | "multi";
  error: string | null;
}

/**
 * Validates the RAW config before anything indexes into it.
 *
 * Lifted out of picker.tsx unchanged so that the canvas shell and any canvas
 * embedding the picker view validate identically. A region with a bad config
 * has to be reported exactly the way a whole canvas with a bad config
 * already is, and that only holds if there is one implementation.
 *
 * What it rejects, and why each one mattered: malformed `options` (not an
 * array, elements missing id/label, duplicate ids), an empty `options`
 * array, an unrecognized `mode`, or every option disabled. Each of those
 * used to either throw inside Ink with nothing surfaced to the controller,
 * or render a canvas that could never be submitted.
 */
export function validatePicker(config: PickerConfig | undefined): ValidatedPicker {
    const rawOptions: unknown = config?.options;
    if (!Array.isArray(rawOptions)) {
      return { options: [], mode: "single", error: "picker config: 'options' must be an array" };
    }
    for (let i = 0; i < rawOptions.length; i++) {
      const o: unknown = rawOptions[i];
      const id = o !== null && typeof o === "object" ? (o as { id?: unknown }).id : undefined;
      const label = o !== null && typeof o === "object" ? (o as { label?: unknown }).label : undefined;
      if (typeof id !== "string" || id.length === 0 || typeof label !== "string" || label.length === 0) {
        return {
          options: [],
          mode: "single",
          error: `picker config: options[${i}] is missing 'id' or 'label'`,
        };
      }
    }
    const candidateOptions = rawOptions as PickerOption[];
    const seenIds = new Set<string>();
    for (const opt of candidateOptions) {
      if (seenIds.has(opt.id)) {
        return {
          options: [],
          mode: "single",
          error: `picker config: duplicate option id ${JSON.stringify(opt.id)}`,
        };
      }
      seenIds.add(opt.id);
    }
    if (candidateOptions.length === 0) {
      return { options: [], mode: "single", error: "picker config: 'options' must not be empty" };
    }
    // `mode` is required, both in PickerConfig and here. It used to be
    // accepted as absent and silently defaulted to "single", so a config
    // that meant multi-select but omitted the field opened a canvas the
    // user could not multi-select in, with nothing reported anywhere. A
    // required field that silently takes a default is worse than one that
    // refuses: the caller cannot tell the two intents apart.
    const rawMode: unknown = config?.mode;
    if (rawMode !== "single" && rawMode !== "multi") {
      return {
        options: [],
        mode: "single",
        error: `picker config: 'mode' must be "single" or "multi", got ${JSON.stringify(rawMode)}`,
      };
    }
    const validMode: "single" | "multi" = rawMode;
    if (!candidateOptions.some((o) => !o.disabled)) {
      return { options: [], mode: validMode, error: "picker config: all options are disabled" };
    }
    return { options: candidateOptions, mode: validMode, error: null };
}
