import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PickerOption, PickerResult } from "./types";

export interface PickerViewProps {
  options: PickerOption[];
  mode: "single" | "multi";
  title?: string;
  prompt?: string;
  /**
   * Total rows this view may paint into; it subtracts its own chrome.
   * Standalone that is the terminal height, and embedded it is whatever the
   * composing canvas allotted the region.
   */
  rows: number;
  /**
   * Only the focused view receives keys. Ink's `useInput` takes `isActive`
   * for exactly this case -- its own docs call it "useful when there are
   * multiple useInput hooks used at once to avoid handling the same input
   * several times" -- so focus routing needs no dispatch layer of our own.
   */
  focused: boolean;
  onSubmit(result: PickerResult): void;
}

// Rows this view spends on chrome rather than options: two border rows, the
// title, a blank line and the footer hint. The prompt adds one more when
// present.
const CHROME_ROWS = 5;

function firstEnabledIndex(options: PickerOption[]): number {
  const idx = options.findIndex((o) => !o.disabled);
  return idx === -1 ? 0 : idx;
}

/**
 * The picker's rendering and local interaction, knowing nothing about IPC,
 * registry records or outcomes.
 *
 * Deliberately does NOT handle Escape. Cancelling belongs to the canvas
 * shell: a view that swallowed Escape would make a composed canvas
 * un-exitable by keyboard through whichever region happened to be focused,
 * which is the failure every primitive's "Escape must always work" rule
 * exists to prevent.
 *
 * It also does not guard a double submit. `onSubmit` may fire more than
 * once; the shell enforces first-outcome-wins, because the outcome is the
 * shell's to own.
 */
export function PickerView({
  options,
  mode,
  title,
  prompt,
  rows,
  focused,
  onSubmit,
}: PickerViewProps): React.JSX.Element {
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

  function moveCursor(delta: number) {
    if (options.length === 0) return;
    let next = cursorRef.current;
    for (let attempts = 0; attempts < options.length; attempts++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setCursor(next);
  }

  useInput((input, key) => {
    if (options.length === 0) return;
    if (key.upArrow || input === "k") {
      moveCursor(-1);
    } else if (key.downArrow || input === "j") {
      moveCursor(1);
    } else if (mode === "single" && key.return) {
      const opt = options[cursorRef.current];
      if (opt && !opt.disabled) onSubmit({ selectedIds: [opt.id] });
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
      onSubmit({ selectedIds: Array.from(checkedRef.current) });
    }
  }, { isActive: focused });

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
  const visibleCount = Math.max(1, rows - CHROME_ROWS - (prompt ? 1 : 0));
  const windowStart =
    options.length <= visibleCount ? 0 : Math.floor(cursor / visibleCount) * visibleCount;
  const visibleOptions = options.slice(windowStart, windowStart + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title ?? "Choose"}</Text>
      {prompt ? <Text dimColor>{prompt}</Text> : null}
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
