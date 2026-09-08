import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { FormConfig, FormField, FormResult } from "./form/types";

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
function validateForm(config: FormConfig | undefined): ValidatedForm {
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

export interface FormProps {
  id: string;
  config?: FormConfig;
  scenario?: string;
  enabled: boolean;
}

type FieldState = string | boolean; // number fields store their raw digit string here too

function initialValue(field: FormField): FieldState {
  if (field.type === "checkbox") return false;
  if (field.type === "select") return field.options[0]?.value ?? "";
  return "";
}

function isMissing(field: FormField, value: FieldState): boolean {
  if (!("required" in field) || !field.required) return false;
  if (field.type === "number") {
    // A required number field must hold an actual number. Empty counts as
    // missing, and so does anything that does not parse to a finite one --
    // a lone "-" typed on the way to "-5" is not a value, and used to reach
    // Number() at submit time and travel to the controller as NaN, which
    // JSON.stringify serializes to `null`.
    if (typeof value !== "string") return true;
    return value.trim().length === 0 || !Number.isFinite(Number(value));
  }
  if (field.type === "text" || field.type === "textarea") {
    return typeof value === "string" && value.trim().length === 0;
  }
  // select always has a value (validateForm rejects an empty options list);
  // checkbox has no required variant -- an unchecked box is a valid false.
  return false;
}

function clampNumber(raw: string, min: number | undefined, max: number | undefined): string {
  if (raw.trim().length === 0) return raw;
  let n = Number(raw);
  // An unparseable entry (the classic case being a lone "-") is cleared
  // rather than preserved. Returning `raw` here is what let NaN survive all
  // the way to the submitted result; clearing it also makes a required
  // field correctly register as missing instead of submitting garbage.
  if (!Number.isFinite(n)) return "";
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return String(n);
}

export function Form({ id, config, scenario = "fill", enabled }: FormProps): React.JSX.Element {
  const { exit } = useApp();
  const { fields, error } = useMemo<ValidatedForm>(() => validateForm(config), [config]);

  const [values, setValues] = useState<Record<string, FieldState>>(() => {
    const init: Record<string, FieldState> = {};
    for (const f of fields) init[f.id] = initialValue(f);
    return init;
  });
  // Mirrors `values` synchronously into a ref on every render (NOT inside a
  // useEffect, which would reintroduce the same one-render lag this is
  // fixing). useInput's handler is re-registered in a passive effect that
  // lags a state commit by roughly 2-4ms, so reading the closed-over
  // `values` directly inside the useInput callback (or in attemptSubmit,
  // which the callback invokes) can observe a stale snapshot: two
  // keystrokes arriving within that window could read a value one
  // keystroke behind. Reading from this ref always sees the latest
  // committed values regardless of which render's useInput registration is
  // currently active. See picker.tsx's `cursorRef`/`checkedRef` and
  // diff.tsx's `cursorRef` for the reference implementation of this
  // pattern.
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const [focusIndex, setFocusIndex] = useState(0); // fields.length === the Submit position
  // Same stale-closure hazard as valuesRef above, for the onSubmit check,
  // the field lookup that routes the rest of the handler, and moveFocus's
  // clamp-on-blur decision.
  const focusIndexRef = useRef(focusIndex);
  focusIndexRef.current = focusIndex;

  const [errors, setErrors] = useState<Set<string>>(new Set());

  // Guards against a second outcome message (Enter-then-Escape, or a
  // double Enter) firing before the component has actually unmounted.
  // picker.tsx and diff.tsx both have this; form.tsx shipped without it, so
  // submitting and then pressing Escape sent BOTH `selected` and
  // `cancelled` and the controller acted on whichever it read first.
  const submittedRef = useRef(false);

  const ipc = useCanvasServer({
    id,
    kind: "form",
    scenario,
    enabled,
    onClose: () => {},
  });

  // Reports a config validation failure to the controller exactly once,
  // when `error` transitions from null to non-null. Gated on
  // `ipc.isConnected` for the same reason as picker.tsx's and diff.tsx's
  // equivalent effects: the IPC server starts asynchronously, so an
  // unconditional send on mount would race its startup and broadcast to
  // zero connections, dropping the message forever.
  const sentRef = useRef(false);
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  function moveFocus(delta: number) {
    const currentField = fields[focusIndexRef.current];
    if (currentField?.type === "number") {
      setValues((prev) => ({
        ...prev,
        [currentField.id]: clampNumber(
          (prev[currentField.id] as string) ?? "",
          currentField.min,
          currentField.max
        ),
      }));
    }
    const total = fields.length + 1; // + Submit
    setFocusIndex((i) => (i + delta + total) % total);
  }

  function attemptSubmit() {
    if (submittedRef.current) return;
    const missing = new Set<string>();
    for (const f of fields) {
      if (isMissing(f, valuesRef.current[f.id] ?? initialValue(f))) missing.add(f.id);
    }
    if (missing.size > 0) {
      setErrors(missing);
      const firstMissingIndex = fields.findIndex((f) => missing.has(f.id));
      if (firstMissingIndex !== -1) setFocusIndex(firstMissingIndex);
      return;
    }
    const outValues: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      const v = valuesRef.current[f.id] ?? initialValue(f);
      if (f.type === "checkbox") {
        outValues[f.id] = Boolean(v);
      } else if (f.type === "number") {
        const raw = v as string;
        const n = Number(clampNumber(raw, f.min, f.max));
        // Defensive: clampNumber already clears anything unparseable and
        // isMissing already rejects it for a required field, so a
        // non-finite value can only reach here from an optional field left
        // in a partial state. 0 matches the existing empty-field behavior;
        // what must never happen is NaN, which serializes to null on the
        // wire and silently becomes a null in Claude's hands.
        outValues[f.id] = Number.isFinite(n) ? n : 0;
      } else {
        outValues[f.id] = v as string;
      }
    }
    submittedRef.current = true;
    const result: FormResult = { values: outValues };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    // Escape must always work, in every state (config error, mid-entry,
    // post-validation-failure) so the pane is never un-exitable by
    // keyboard. Copies picker.tsx's and diff.tsx's exact ordering.
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (fields.length === 0) return;
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }

    const onSubmit = focusIndexRef.current === fields.length;
    if (onSubmit) {
      if (key.return) attemptSubmit();
      return;
    }

    const field = fields[focusIndexRef.current];
    if (!field) return;

    if (field.type === "checkbox") {
      if (input === " ") setValues((prev) => ({ ...prev, [field.id]: !prev[field.id] }));
      return;
    }
    if (field.type === "select") {
      const opts = field.options;
      if (opts.length === 0) return;
      if (key.leftArrow) {
        setValues((prev) => {
          const current = prev[field.id];
          const currentIndex = Math.max(0, opts.findIndex((o) => o.value === current));
          const next = opts[(currentIndex - 1 + opts.length) % opts.length]!;
          return { ...prev, [field.id]: next.value };
        });
      } else if (key.rightArrow) {
        setValues((prev) => {
          const current = prev[field.id];
          const currentIndex = Math.max(0, opts.findIndex((o) => o.value === current));
          const next = opts[(currentIndex + 1) % opts.length]!;
          return { ...prev, [field.id]: next.value };
        });
      }
      return;
    }
    if (field.type === "number") {
      if (key.backspace || key.delete) {
        setValues((prev) => {
          const raw = (prev[field.id] as string) ?? "";
          return { ...prev, [field.id]: raw.slice(0, -1) };
        });
      } else if (/^[0-9]$/.test(input)) {
        setValues((prev) => {
          const raw = (prev[field.id] as string) ?? "";
          return { ...prev, [field.id]: raw + input };
        });
      } else if (input === "-" && (field.min ?? -1) < 0) {
        setValues((prev) => {
          const raw = (prev[field.id] as string) ?? "";
          if (raw.length !== 0) return prev;
          return { ...prev, [field.id]: raw + input };
        });
      }
      return;
    }
    // text or textarea
    if (key.backspace || key.delete) {
      setValues((prev) => {
        const text = (prev[field.id] as string) ?? "";
        return { ...prev, [field.id]: text.slice(0, -1) };
      });
    } else if (field.type === "textarea" && key.return) {
      setValues((prev) => {
        const text = (prev[field.id] as string) ?? "";
        return { ...prev, [field.id]: text + "\n" };
      });
    } else if (input && !key.return) {
      setValues((prev) => {
        const text = (prev[field.id] as string) ?? "";
        return { ...prev, [field.id]: text + input };
      });
    }
  });

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Fill in the form"}</Text>
      {fields.map((f, i) => {
        const isFocused = i === focusIndex;
        const hasError = errors.has(f.id);
        const value = values[f.id] ?? initialValue(f);
        const labelColor = hasError ? "red" : isFocused ? "cyan" : undefined;
        const requiredMark = "required" in f && f.required ? " *" : "";
        return (
          <Box key={f.id} flexDirection="column">
            {/* A missing required field carries a text marker, not just a
                red label. picker.tsx already fixed this exact weakness for
                its cursor gutter -- a state expressed solely through
                `color` is invisible in a no-color terminal, and the spec's
                hard rule here is that a failed submit must report WHICH
                fields are missing. */}
            <Text color={labelColor}>
              {isFocused ? "> " : "  "}
              {f.label}
              {requiredMark}
              {hasError ? "  <- required" : ""}
            </Text>
            <Box marginLeft={2}>
              {f.type === "checkbox" ? (
                <Text>{value ? "[x]" : "[ ]"}</Text>
              ) : f.type === "select" ? (
                <Text>
                  {"< "}
                  {f.options.find((o) => o.value === value)?.label ?? ""}
                  {" >"}
                </Text>
              ) : (
                // text / textarea / number.
                //
                // A field must always have visible extent. An empty value
                // with no placeholder used to render an empty <Text> that
                // collapsed to nothing, so the focused field the user was
                // typing into had no visible line at all -- found by the
                // 2026-09-08 tmux smoke test, where the form pane showed
                // "> Who *" with nothing beneath it. The snapshot fixtures
                // all gave their textarea a placeholder, which is why no
                // test caught it.
                //
                // The cursor sits where the next character will land, so it
                // follows the typed text. An unfocused empty field falls
                // back to a dim rule rather than nothing.
                (() => {
                  const raw = (value as string) ?? "";
                  const placeholder =
                    "placeholder" in f && f.placeholder ? f.placeholder : undefined;
                  const body = raw.length > 0 ? raw : (placeholder ?? "");
                  const filler = body.length === 0 && !isFocused ? "—" : "";
                  return (
                    <Text dimColor={raw.length === 0}>
                      {body}
                      {filler}
                      {isFocused ? "▏" : ""}
                    </Text>
                  );
                })()
              )}
            </Box>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={focusIndex === fields.length ? "cyan" : undefined} bold={focusIndex === fields.length}>
          {focusIndex === fields.length ? "> " : "  "}[ Submit ]
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Tab/Shift+Tab: move  Enter: submit (on the button)  Esc: cancel</Text>
      </Box>
    </Box>
  );
}
