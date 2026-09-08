import React, { useRef, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { PickerConfig, PickerResult } from "./picker/types";

export interface PickerProps {
  id: string;
  config?: PickerConfig;
  scenario?: string;
  enabled: boolean;
}

function firstEnabledIndex(options: PickerConfig["options"]): number {
  const idx = options.findIndex((o) => !o.disabled);
  return idx === -1 ? 0 : idx;
}

export function Picker({ id, config, scenario = "select", enabled }: PickerProps): React.JSX.Element {
  const { exit } = useApp();
  const options = config?.options ?? [];
  const mode = config?.mode ?? "single";

  const [cursor, setCursor] = useState(() => firstEnabledIndex(options));
  // Mirrors `cursor` synchronously into a ref on every render (NOT inside a
  // useEffect, which would reintroduce the same one-render lag this is
  // fixing). useInput's handler is re-registered in a passive effect that
  // lags a state commit by roughly 2-4ms, so reading the closed-over
  // `cursor` directly inside the useInput callback can observe a stale
  // value: two keystrokes arriving within that window (e.g. move then
  // select) could read the PREVIOUS cursor position. Reading from this ref
  // always sees the latest committed cursor regardless of which render's
  // useInput registration is currently active. See diff.tsx's `cursorRef`
  // for the reference implementation of this pattern.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Same stale-closure hazard as cursorRef above, for multi-mode's toggle
  // and submit reads of `checked`.
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  const ipc = useCanvasServer({
    id,
    kind: "picker",
    scenario,
    enabled,
    onClose: () => {},
  });

  function moveCursor(delta: number) {
    if (options.length === 0) return;
    let next = cursorRef.current;
    for (let attempts = 0; attempts < options.length; attempts++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setCursor(next);
  }

  function submit(ids: string[]) {
    const result: PickerResult = { selectedIds: ids };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    if (options.length === 0) return;
    if (key.upArrow || input === "k") {
      moveCursor(-1);
    } else if (key.downArrow || input === "j") {
      moveCursor(1);
    } else if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
    } else if (mode === "single" && key.return) {
      const opt = options[cursorRef.current];
      if (opt && !opt.disabled) submit([opt.id]);
    } else if (mode === "multi" && input === " ") {
      const opt = options[cursorRef.current];
      if (opt && !opt.disabled) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(opt.id)) next.delete(opt.id);
          else next.add(opt.id);
          return next;
        });
      }
    } else if (mode === "multi" && key.return) {
      submit(Array.from(checkedRef.current));
    }
  });

  if (options.length === 0) {
    return (
      <Box borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">No options to choose from.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Choose"}</Text>
      {config?.prompt ? <Text dimColor>{config.prompt}</Text> : null}
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isChecked = mode === "multi" && checked.has(opt.id);
        const prefix = mode === "multi" ? (isChecked ? "[x] " : "[ ] ") : isCursor ? "> " : "  ";
        return (
          <Text
            key={opt.id}
            color={opt.disabled ? undefined : isCursor ? "cyan" : undefined}
            dimColor={opt.disabled}
          >
            {prefix}
            {opt.label}
            {opt.description ? ` — ${opt.description}` : ""}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {mode === "single"
            ? "↑/↓: navigate  Enter: select  Esc: cancel"
            : "↑/↓: navigate  Space: toggle  Enter: submit  Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}
