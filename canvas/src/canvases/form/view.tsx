import React, { useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth, truncateToWidthFromEnd, wrappedLineCount } from "../width";
import type { FormField, FormResult } from "./types";

export interface FormViewProps {
  fields: FormField[];
  title?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  /**
   * Terminal width, for estimating whether the footer hint wraps at a
   * narrow width. Optional and defaults to 80 (Ink's own stdout default) so
   * a composing canvas without a meaningful per-region width doesn't have
   * to pass one.
   */
  columns?: number;
  focused: boolean;
  onSubmit(result: FormResult): void;
}

// Rows this view spends on chrome rather than fields: two border rows, the
// title, the blank line before Submit, Submit itself, the blank line after
// it, and the hint.
const CHROME_ROWS = 7;
// Every field paints a label row and a value row.
const ROWS_PER_FIELD = 2;
// Horizontal chrome the outer box spends: one column of border on each side
// plus one column of paddingX on each side.
const HORIZONTAL_CHROME = 4;
const FOOTER_HINT = "Tab/Shift+Tab: move  Enter: submit (on the button)  Esc: cancel";

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

function windowStartFor(total: number, focusIndex: number, visibleFields: number): number {
  if (total <= visibleFields) return 0;
  return Math.min(
    Math.floor(Math.min(focusIndex, total - 1) / visibleFields) * visibleFields,
    total - visibleFields
  );
}

/**
 * The dynamic position-indicator prefix the footer actually renders (e.g.
 * "3-4 of 9  "), or "" when every field fits without windowing -- exactly
 * mirroring the footer's own render-time condition and computation below,
 * so the row-budget math can measure the string that will actually appear
 * instead of just the static hint.
 */
function positionPrefix(total: number, focusIndex: number, visibleFields: number): string {
  if (total <= visibleFields) return "";
  const start = windowStartFor(total, focusIndex, visibleFields);
  const visibleLen = Math.min(visibleFields, total - start);
  return `${start + 1}-${start + visibleLen} of ${total}  `;
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

/**
 * The form's fields, focus and validation feedback, knowing nothing about
 * IPC or outcomes.
 *
 * Escape belongs to the canvas shell -- see picker/view.tsx. Submitting
 * lives here because refusing to submit is itself view behaviour: a missing
 * required field keeps the form open and marks the field, and only a
 * complete form calls onSubmit at all.
 *
 */
export function FormView({
  fields,
  title,
  budget,
  columns = 80,
  focused,
  onSubmit,
}: FormViewProps): React.JSX.Element {
  // `values` used to be a `useState` with a `useRef` mirror written only in
  // the render body -- the same pattern used successfully for `focusIndex`
  // below. That works when every place a new value is decided also writes
  // the ref directly at that moment. It does NOT work when there are many
  // call sites deciding new values (this component's useInput handler has
  // one per field type: text, textarea, number, checkbox, select) and even
  // one of them is missed, because a render-body-only mirror only catches
  // up on the NEXT commit -- typically 2-4ms later, well after a second
  // zero-delay keystroke in the same burst can already have reached the
  // handler and read the stale value. That is exactly what happened here:
  // the mirror was added, but none of the (then eleven) setValues call
  // sites also wrote `valuesRef.current` directly, so a burst like "type a
  // character, then Tab, then Enter" with no delay at all between any of
  // the three could submit successfully with the field's PRE-edit value --
  // worse than a hang, because the controller has no way to tell the
  // submission was wrong.
  //
  // Rather than hand-patch eleven call sites with a matching direct ref
  // write each (the approach that let this slip through once already),
  // `values` now lives ONLY in this ref. There is no separate `useState`
  // for it and therefore no second copy that can fall out of sync: every
  // read (in the handler, in attemptSubmit, in the render body) goes
  // through `valuesRef.current`, and every write mutates it directly via
  // `setValue` below, which also fires a bare re-render so the pane
  // actually repaints. This makes the missed-call-site failure mode
  // structurally impossible rather than merely audited against.
  const valuesRef = useRef<Record<string, FieldState>>(
    (() => {
      const init: Record<string, FieldState> = {};
      for (const f of fields) init[f.id] = initialValue(f);
      return init;
    })()
  );
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  function setValue(id: string, value: FieldState): void {
    valuesRef.current = { ...valuesRef.current, [id]: value };
    forceRender();
  }

  const [focusIndex, setFocusIndex] = useState(0); // fields.length === the Submit position
  // Same stale-closure hazard as valuesRef above, for the onSubmit check,
  // the field lookup that routes the rest of the handler, and moveFocus's
  // clamp-on-blur decision.
  const focusIndexRef = useRef(focusIndex);
  focusIndexRef.current = focusIndex;

  const [errors, setErrors] = useState<Set<string>>(new Set());

  function moveFocus(delta: number) {
    const currentField = fields[focusIndexRef.current];
    if (currentField?.type === "number") {
      setValue(
        currentField.id,
        clampNumber(
          (valuesRef.current[currentField.id] as string) ?? "",
          currentField.min,
          currentField.max
        )
      );
    }
    const total = fields.length + 1; // + Submit
    // Written directly into the ref here, not left to the render-body
    // mirror alone: two keystrokes with truly zero delay between them (real
    // burst input, not just a fast setTimeout) can both reach this handler
    // before React has committed the render that would otherwise update
    // focusIndexRef.current. Without this direct write, a Tab (move to
    // Submit) immediately followed by Enter would have the onSubmitButton
    // check in the useInput callback below read the ref's stale pre-move
    // value and silently swallow the submit. See the class comment on
    // focusIndexRef above.
    const next = (focusIndexRef.current + delta + total) % total;
    focusIndexRef.current = next;
    setFocusIndex(next);
  }

  function attemptSubmit() {
    const missing = new Set<string>();
    for (const f of fields) {
      if (isMissing(f, valuesRef.current[f.id] ?? initialValue(f))) missing.add(f.id);
    }
    if (missing.size > 0) {
      setErrors(missing);
      const firstMissingIndex = fields.findIndex((f) => missing.has(f.id));
      if (firstMissingIndex !== -1) {
        // Direct ref write, same reasoning as moveFocus above: attemptSubmit
        // is itself deciding a new focusIndex here.
        focusIndexRef.current = firstMissingIndex;
        setFocusIndex(firstMissingIndex);
      }
      return;
    }
    const outValues: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      const v = valuesRef.current[f.id] ?? initialValue(f);
      if (f.type === "checkbox") {
        outValues[f.id] = Boolean(v);
      } else if (f.type === "number") {
        const raw = v as string;
        const clamped = clampNumber(raw, f.min, f.max);
        if (clamped.trim().length === 0) {
          // An optional (non-required -- isMissing already blocked
          // submission above if this field were required) number field
          // left blank, or holding only unparseable input like a lone "-",
          // has no value to submit. `Number("")` evaluates to 0 in
          // JavaScript, which used to reach the wire regardless of the
          // field's own declared `min` -- a field with {min: 5} left
          // untouched used to silently submit {"n": 0}, violating its own
          // constraint. Omitting the key is honest about "never answered"
          // in a way a synthesized 0 was not, and matches how an optional
          // select/text field's "untouched" state is represented by its
          // own initial value rather than a value the field's rules forbid.
          continue;
        }
        const n = Number(clamped);
        // Defensive: clampNumber only returns a non-empty string, and the
        // blank/unparseable case is handled above, so a non-finite value
        // should be unreachable here. What must never happen is NaN
        // reaching the wire, which JSON.stringify serializes to null.
        outValues[f.id] = Number.isFinite(n) ? n : 0;
      } else {
        outValues[f.id] = v as string;
      }
    }
    onSubmit({ values: outValues });
  }

  useInput((input, key) => {
    if (fields.length === 0) return;
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }

    const onSubmitButton = focusIndexRef.current === fields.length;
    if (onSubmitButton) {
      if (key.return) attemptSubmit();
      return;
    }

    const field = fields[focusIndexRef.current];
    if (!field) return;

    if (field.type === "checkbox") {
      if (input === " ") setValue(field.id, !valuesRef.current[field.id]);
      return;
    }
    if (field.type === "select") {
      const opts = field.options;
      if (opts.length === 0) return;
      if (key.leftArrow) {
        const current = valuesRef.current[field.id];
        const currentIndex = Math.max(0, opts.findIndex((o) => o.value === current));
        const nextOpt = opts[(currentIndex - 1 + opts.length) % opts.length]!;
        setValue(field.id, nextOpt.value);
      } else if (key.rightArrow) {
        const current = valuesRef.current[field.id];
        const currentIndex = Math.max(0, opts.findIndex((o) => o.value === current));
        const nextOpt = opts[(currentIndex + 1) % opts.length]!;
        setValue(field.id, nextOpt.value);
      }
      return;
    }
    if (field.type === "number") {
      if (key.backspace || key.delete) {
        const raw = (valuesRef.current[field.id] as string) ?? "";
        setValue(field.id, raw.slice(0, -1));
      } else if (/^[0-9]$/.test(input)) {
        const raw = (valuesRef.current[field.id] as string) ?? "";
        setValue(field.id, raw + input);
      } else if (input === "-" && (field.min ?? -1) < 0) {
        const raw = (valuesRef.current[field.id] as string) ?? "";
        if (raw.length === 0) setValue(field.id, raw + input);
      }
      return;
    }
    // text or textarea
    if (key.backspace || key.delete) {
      const text = (valuesRef.current[field.id] as string) ?? "";
      setValue(field.id, text.slice(0, -1));
    } else if (field.type === "textarea" && key.return) {
      const text = (valuesRef.current[field.id] as string) ?? "";
      setValue(field.id, text + "\n");
    } else if (input && !key.return) {
      const text = (valuesRef.current[field.id] as string) ?? "";
      setValue(field.id, text + input);
    }
  }, { isActive: focused });

  // A form with more fields than the pane has rows used to render all of
  // them, overflowing exactly as picker, diff and table did before they were
  // given windows -- and worse than those, because the overflow pushed the
  // Submit button itself out of view, leaving a form that could be filled in
  // and not submitted.
  //
  // Windowed on the focus index, paging rather than centring, for the same
  // reason as every other view: the list moves only when focus crosses a
  // boundary instead of shifting under the user on every Tab. The Submit
  // position (focusIndex === fields.length) belongs to the last page.
  // At a narrow terminal width the footer hint itself wraps onto a second
  // line, which CHROME_ROWS's flat "one line of hint text" assumption
  // doesn't account for -- so reserve however many extra rows the footer's
  // actual wrapped height needs, on top of the fixed chrome.
  //
  // The footer that actually renders is a dynamic position prefix (e.g.
  // "3-4 of 9  ") followed by the static hint -- not the hint alone -- and
  // the prefix widens the string enough to push it onto an extra wrapped
  // row the hint-only measurement never accounted for. The prefix's own
  // width depends on `visibleFields`, which is what this budget calculation
  // produces, so this runs the estimate twice: once with just the hint to
  // get a candidate `visibleFields`, then measures the ACTUAL footer string
  // that candidate would produce and re-derives `visibleFields` from that.
  // See picker/view.tsx's identical two-pass treatment for why one extra
  // pass is enough in practice.
  const innerWidth = Math.max(1, columns - HORIZONTAL_CHROME);
  let footerRows = wrappedLineCount(FOOTER_HINT, innerWidth);
  let footerOverflow = Math.max(0, footerRows - 1);
  let visibleFields = Math.max(
    1,
    Math.floor((budget - CHROME_ROWS - footerOverflow) / ROWS_PER_FIELD)
  );
  const actualFooter =
    positionPrefix(fields.length, focusIndex, visibleFields) + FOOTER_HINT;
  footerRows = wrappedLineCount(actualFooter, innerWidth);
  footerOverflow = Math.max(0, footerRows - 1);
  visibleFields = Math.max(
    1,
    Math.floor((budget - CHROME_ROWS - footerOverflow) / ROWS_PER_FIELD)
  );
  const windowStart = windowStartFor(fields.length, focusIndex, visibleFields);
  const windowFields = fields.slice(windowStart, windowStart + visibleFields);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>{title ?? "Fill in the form"}</Text>
      {windowFields.map((f, visibleIndex) => {
        const i = windowStart + visibleIndex;
        // Gated on the dashboard-level `focused` prop as well as the
        // internal per-field `focusIndex`: a composed dashboard can mount
        // this view while another region holds the dashboard's focus, and
        // this view's own field cursor/highlight must not keep showing as
        // live in that state -- previously it ignored `focused` entirely,
        // so an unfocused form region still showed a highlighted field and
        // a blinking-looking trailing cursor. Standalone usage always
        // passes `focused`, so this is a no-op there.
        const isFocused = i === focusIndex && focused;
        const value = valuesRef.current[f.id] ?? initialValue(f);
        // `errors` only ever GROWS a field into it, at submit-attempt time
        // -- it never removes one, because removing it eagerly on every
        // keystroke would need its own effect. Gating the marker on
        // `isMissing` as well, recomputed live from the current `value`
        // every render, means a field that was flagged and then corrected
        // stops showing "<- required" the moment it stops actually being
        // missing, without needing to mutate `errors` itself.
        const hasError = errors.has(f.id) && isMissing(f, value);
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
                  // The multi-line marker and the width-based truncation
                  // below must only ever describe what the user actually
                  // typed. A placeholder is fallback copy the user never
                  // entered -- if it happened to contain a newline, counting
                  // it toward `lines` would show a "(N lines, showing last)"
                  // marker for text nobody typed. Falling back to
                  // `placeholder`'s first line only (dropping the rest
                  // outright, not truncating with a marker) is a strict
                  // improvement here anyway: this codebase's own field
                  // definitions never give a placeholder embedded newlines
                  // in practice, so this only ever changes behaviour for a
                  // placeholder that would otherwise have been misrepresented
                  // as user-entered multi-line content.
                  const typed = raw.length > 0;
                  const body = typed ? raw : ((placeholder ?? "").split("\n")[0] ?? "");
                  const filler = body.length === 0 && !isFocused ? "—" : "";
                  // `text` and `number` never contain a newline (nothing in
                  // the input handler above ever inserts one for them), so
                  // `lines` is always a single entry for those types. A
                  // `textarea`, though, can hold arbitrarily many lines --
                  // Enter inserts one instead of submitting.
                  const lines = typed && body.includes("\n") ? body.split("\n") : [body];
                  const lastLine = lines[lines.length - 1] ?? "";
                  const truncated = lines.length > 1;
                  const marker = truncated ? `(${lines.length} lines, showing last) ` : "";
                  // Rendering the full last line unconditionally used to blow
                  // straight through the field's own one-value-row budget
                  // (the same "value row" every other field type is windowed
                  // to, per ROWS_PER_FIELD): counting only embedded `\n`
                  // characters completely missed a single line with none at
                  // all (a long line word-wraps across many terminal rows
                  // regardless of whether it ever contained a newline), and
                  // even the multi-line case could still overflow once the
                  // marker text and a genuinely long last line were measured
                  // together -- the marker consumes width too, and nothing
                  // accounted for that either.
                  //
                  // The fix measures real display width, not newline count:
                  // marker + shown content + the trailing cursor/filler must
                  // together fit within one row's available width, so this
                  // box can never wrap onto a second terminal row no matter
                  // how long the input or how wide the marker. This
                  // component only supports typing that appends and
                  // Backspace that removes from the end (no interior cursor
                  // movement), so the cursor is always on the tail of the
                  // last line -- showing THAT tail (not the head) keeps it
                  // visible by construction once truncation is needed.
                  const availableWidth = Math.max(
                    0,
                    columns - HORIZONTAL_CHROME - 2 /* marginLeft */
                  );
                  const trailingWidth = truncated ? 0 : displayWidth(filler);
                  const cursorWidth = isFocused ? 1 : 0;
                  const contentBudget = Math.max(
                    0,
                    availableWidth - displayWidth(marker) - trailingWidth - cursorWidth
                  );
                  const shownLastLine =
                    displayWidth(lastLine) > contentBudget
                      ? truncateToWidthFromEnd(lastLine, contentBudget)
                      : lastLine;
                  return (
                    <Text dimColor={raw.length === 0}>
                      {marker}
                      {shownLastLine}
                      {truncated ? "" : filler}
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
        {(() => {
          const submitFocused = focusIndex === fields.length && focused;
          return (
            <Text color={submitFocused ? "cyan" : undefined} bold={submitFocused}>
              {submitFocused ? "> " : "  "}[ Submit ]
            </Text>
          );
        })()}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {fields.length > visibleFields
            ? `${windowStart + 1}-${windowStart + windowFields.length} of ${fields.length}  `
            : ""}
          Tab/Shift+Tab: move  Enter: submit (on the button)  Esc: cancel
        </Text>
      </Box>
    </Box>
  );
}
