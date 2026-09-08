import React, { useRef, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { FormConfig, FormField, FormResult } from "./form/types";

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
  if (field.type === "text" || field.type === "textarea" || field.type === "number") {
    return typeof value === "string" && value.trim().length === 0;
  }
  return false; // select always has a value once options are non-empty; checkbox has no required
}

function clampNumber(raw: string, min: number | undefined, max: number | undefined): string {
  if (raw.trim().length === 0) return raw;
  let n = Number(raw);
  if (Number.isNaN(n)) return raw;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return String(n);
}

export function Form({ id, config, scenario = "fill", enabled }: FormProps): React.JSX.Element {
  const { exit } = useApp();
  const fields = config?.fields ?? [];

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

  const ipc = useCanvasServer({
    id,
    kind: "form",
    scenario,
    enabled,
    onClose: () => {},
  });

  function moveFocus(delta: number) {
    const currentField = fields[focusIndexRef.current];
    if (currentField?.type === "number") {
      setValues((prev) => ({
        ...prev,
        [currentField.id]: clampNumber(prev[currentField.id] as string, currentField.min, currentField.max),
      }));
    }
    const total = fields.length + 1; // + Submit
    setFocusIndex((i) => (i + delta + total) % total);
  }

  function attemptSubmit() {
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
        outValues[f.id] = raw.trim().length === 0 ? 0 : Number(clampNumber(raw, f.min, f.max));
      } else {
        outValues[f.id] = v as string;
      }
    }
    const result: FormResult = { values: outValues };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
      return;
    }
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

  if (fields.length === 0) {
    return (
      <Box borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">No fields to fill in.</Text>
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
            <Text color={labelColor}>
              {isFocused ? "> " : "  "}
              {f.label}
              {requiredMark}
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
                <Text dimColor={!value && Boolean("placeholder" in f && f.placeholder)}>
                  {(value as string) || ("placeholder" in f ? f.placeholder : undefined) || ""}
                </Text>
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
