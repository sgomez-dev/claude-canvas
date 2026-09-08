import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import type { PickerConfig, PickerOption, PickerResult } from "./picker/types";

export interface PickerProps {
  id: string;
  config?: PickerConfig;
  scenario?: string;
  enabled: boolean;
}

interface ValidatedPicker {
  options: PickerOption[];
  mode: "single" | "multi";
  error: string | null;
}

// Rows this component spends on chrome rather than options: two border
// rows, the title, a blank line and the footer hint. The prompt adds one
// more when present.
const CHROME_ROWS = 5;

function firstEnabledIndex(options: PickerOption[]): number {
  const idx = options.findIndex((o) => !o.disabled);
  return idx === -1 ? 0 : idx;
}

export function Picker({ id, config, scenario = "select", enabled }: PickerProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Options, mode, and any config error are derived from ONE memo so there
  // is a single source of truth for "is this config usable at all" — see
  // diff.tsx's combined `{files, error}` memo for the reference pattern.
  // Previously `options`/`mode` were derived inline
  // (`config?.options ?? []`, `config?.mode ?? "single"`) with no
  // validation at all, and fed straight into the cursor's useState
  // initializer and the render body: malformed `options` (not an array,
  // elements missing id/label, duplicate ids), an empty `options` array,
  // an unrecognized `mode` string, or every option disabled would each
  // either throw inside Ink with no error surfaced to the controller, or
  // render a canvas that could never be submitted (sometimes with Escape
  // unreachable too). Validating the *raw* config here, before any
  // indexing or useState initializer touches it, closes all of those gaps
  // at once.
  const { options, mode, error } = useMemo<ValidatedPicker>(() => {
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
  }, [config?.options, config?.mode]);

  // Cursor state and its ref always exist (hooks are unconditional every
  // render — see diff.tsx's identical structure). When `error` is set,
  // `options` is the empty-array fallback from the memo above, so
  // `firstEnabledIndex` safely returns 0 rather than indexing into
  // unvalidated data.
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

  // Guards against a second outcome message (Enter-then-Enter,
  // Enter-then-Escape, etc.) firing before the component has actually
  // unmounted. See diff.tsx's `submittedRef` for the reference pattern.
  const submittedRef = useRef(false);

  const ipc = useCanvasServer({
    id,
    kind: "picker",
    scenario,
    enabled,
    onClose: () => {},
  });

  // Reports a config validation failure to the controller exactly once,
  // when `error` transitions from null to non-null. Gated on
  // `ipc.isConnected` for the same reason as diff.tsx's own sendError
  // effect: the IPC server starts asynchronously (real filesystem I/O for
  // the registry record), so an unconditional send on mount would race the
  // server's startup and broadcast to zero connections, silently dropping
  // the message forever. This effect re-runs when `isConnected` flips to
  // true and sends then; `sentRef` keeps that to a single send even if
  // this effect re-runs again afterward.
  const sentRef = useRef(false);
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

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
    if (submittedRef.current) return;
    submittedRef.current = true;
    const result: PickerResult = { selectedIds: ids };
    ipc.sendSelected(result);
    exit();
  }

  useInput((input, key) => {
    // Escape must always work, in every state (config error, normal
    // selection) — checked first and unconditionally so the pane is never
    // un-exitable by keyboard. Copies diff.tsx's exact ordering.
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow || input === "k") {
      moveCursor(-1);
    } else if (key.downArrow || input === "j") {
      moveCursor(1);
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

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  // A list longer than the pane used to render every option, overflowing the
  // terminal and pushing the footer hint (and sometimes the cursor itself)
  // out of view -- a picker over a file list or a branch list hits this
  // immediately.
  //
  // The window is derived from the cursor rather than held in state: a
  // separate scrollOffset would need an effect to keep it in sync with the
  // cursor, which costs an extra render per keystroke and can desync from
  // the cursorRef the input handler reads. Paging (rather than centring the
  // cursor) means the list only moves when the cursor crosses a boundary,
  // instead of shifting under the user on every keypress.
  const visibleCount = Math.max(
    1,
    (stdout?.rows ?? 24) - CHROME_ROWS - (config?.prompt ? 1 : 0)
  );
  const windowStart =
    options.length <= visibleCount ? 0 : Math.floor(cursor / visibleCount) * visibleCount;
  const visibleOptions = options.slice(windowStart, windowStart + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{config?.title ?? "Choose"}</Text>
      {config?.prompt ? <Text dimColor>{config.prompt}</Text> : null}
      {visibleOptions.map((opt, visibleIndex) => {
        const i = windowStart + visibleIndex;
        const isCursor = i === cursor;
        const isChecked = mode === "multi" && checked.has(opt.id);
        // Multi-mode gives the cursor its own gutter (`> `/`  `) ahead of
        // the checkbox so cursor position is visible even with color
        // stripped — previously the cursor was expressed solely via
        // `color="cyan"` on the row, invisible in a no-color terminal.
        // Single mode keeps its existing `> `/`  ` prefix unchanged.
        const prefix =
          mode === "multi"
            ? `${isCursor ? "> " : "  "}${isChecked ? "[x] " : "[ ] "}`
            : isCursor
              ? "> "
              : "  ";
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
          {options.length > visibleCount
            ? `${windowStart + 1}-${windowStart + visibleOptions.length} of ${options.length}  `
            : ""}
          {mode === "single"
            ? "↑/↓: navigate  Enter: select  Esc: cancel"
            : "↑/↓: navigate  Space: toggle  Enter: submit  Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}
