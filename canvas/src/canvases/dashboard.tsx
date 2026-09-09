import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { PickerView } from "./picker/view";
import { TableView } from "./table/view";
import { FormView } from "./form/view";
import { DiffView } from "./diff/view";
import { TreeView } from "./tree/view";
import { validatePicker } from "./picker/validate";
import { validateTable } from "./table/validate";
import { validateForm } from "./form/validate";
import { validateTree } from "./tree/validate";
import { parseDiffConfig } from "./diff/validate";
import { validateDashboard } from "./dashboard/validate";
import type { DashboardConfig, DashboardRegion, DashboardResult } from "./dashboard/types";

export interface DashboardProps {
  id: string;
  config?: DashboardConfig;
  scenario?: string;
  enabled: boolean;
}

// Two border rows plus the title.
const CHROME_ROWS = 3;
// A region needs at least this much to show a border and one row of content.
const MIN_REGION_ROWS = 3;

/** A `text` region has no interaction, so focus skips it. */
function isFocusable(region: DashboardRegion): boolean {
  return region.kind !== "text";
}

/**
 * Divides the pane between the regions.
 *
 * Regions with an explicit `rows` get it; the rest share what is left, with
 * the remainder handed to the earliest of them so the total always adds up
 * exactly. No region goes below MIN_REGION_ROWS even if that overflows --
 * a region too short to draw its own border is worse than a pane that
 * scrolls, and the alternative (dropping regions) hides content the caller
 * asked for.
 */
export function allocateRows(regions: DashboardRegion[], budget: number): number[] {
  const fixed = regions.map((r) => r.rows);
  const flexible = fixed.filter((r) => r === undefined).length;
  // Explicit accumulator type: `fixed` is (number | undefined)[], so an
  // inferred `sum` picks up the undefined and noUncheckedIndexedAccess
  // rejects the arithmetic.
  const spentOnFixed = fixed.reduce<number>((sum, r) => sum + (r ?? 0), 0);
  if (flexible === 0) return fixed.map((r) => Math.max(MIN_REGION_ROWS, r!));

  const left = Math.max(flexible * MIN_REGION_ROWS, budget - spentOnFixed);
  const each = Math.floor(left / flexible);
  let remainder = left - each * flexible;
  return fixed.map((r) => {
    if (r !== undefined) return Math.max(MIN_REGION_ROWS, r);
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return Math.max(MIN_REGION_ROWS, each + extra);
  });
}

/**
 * The dashboard canvas: several primitive views in one pane.
 *
 * This is what sub-project 1's split was for. The shell owns the config, the
 * IPC server, Escape, focus and the single outcome; each region is a view
 * that renders and handles its own keys when focused, and knows nothing
 * about any of that.
 *
 * It renders a config rather than gathering one -- it runs no git, no test
 * suite, nothing. Claude gathers and pushes, and refresh is the `update`
 * verb. A canvas that shelled out would need a permissions story, a refresh
 * story and an error story per command, and would be the first thing here to
 * execute arbitrary commands.
 */
export function Dashboard({
  id,
  config: initialConfig,
  scenario = "display",
  enabled,
}: DashboardProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [config, setConfig] = useState<DashboardConfig | undefined>(initialConfig);
  const [generation, setGeneration] = useState(0);

  const { regions, error } = useMemo(() => validateDashboard(config), [config]);

  const focusable = useMemo(() => {
    const out: number[] = [];
    regions.forEach((r, i) => {
      if (isFocusable(r)) out.push(i);
    });
    return out;
  }, [regions]);

  const [focusSlot, setFocusSlot] = useState(0);
  const focusSlotRef = useRef(focusSlot);
  focusSlotRef.current = focusSlot;

  const submittedRef = useRef(false);
  const sentRef = useRef(false);

  const ipc = useCanvasServer({
    id,
    kind: "dashboard",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as DashboardConfig);
      setGeneration((g) => g + 1);
      setFocusSlot(0);
      sentRef.current = false;
    },
  });

  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  // Escape and region-switching are the shell's. Escape for the reason
  // every primitive has it in its shell; region-switching because focus is
  // a property of the composition, not of any one region.
  //
  // Region-switching used to be Tab/Shift+Tab, which reads naturally next
  // to picker/table/tree/diff (none of which give Tab any meaning of their
  // own, so the shell was the only consumer). It collided with `form`:
  // FormView ALSO binds Tab, to move between its own fields, and Ink calls
  // every active `useInput` handler for the same keypress rather than
  // routing it to one -- this handler has no `isActive` gate at all, so a
  // single Tab both advanced the focused form's field cursor AND changed
  // which region the shell considers focused. Reproduced directly: a
  // dashboard with a 2-field form plus a picker, one Tab moved the form
  // from field 1 to field 2 AND handed dashboard focus to the picker in
  // the same keystroke -- with N regions, filling one form field needed N
  // Tabs, and the two effects were impossible to tell apart from the
  // user's side.
  //
  // Home/End were picked to replace Tab/Shift+Tab here, not a Ctrl/Shift
  // combination, for two reasons checked against this codebase and Ink's
  // own key parser (parse-keypress.js) rather than assumed:
  //   1. Ctrl+Tab has no legacy (non-kitty) terminal representation at all
  //      -- Tab and Ctrl+I are the same byte (0x09) in plain ASCII, so a
  //      terminal that isn't speaking the kitty keyboard protocol cannot
  //      send a Ctrl+Tab distinct from a plain Tab. tmux and Windows
  //      Terminal, this project's two supported hosts, don't forward it.
  //   2. Shift+Tab was briefly considered too, and rejected for the reason
  //      the spec calls out: FormView already binds it (backward field
  //      navigation), so reusing it here would recreate the exact same
  //      collision one key over.
  // Home/End avoid both problems: they have unambiguous legacy CSI
  // sequences (no kitty protocol needed) and, checked against every
  // composed view kind (picker, form, table, diff, tree), none of them
  // binds `key.home` or `key.end` to anything -- unlike arrow keys, which
  // form's `select` fields and tree's fold/expand both already claim, Home/
  // End were the one pair left with zero existing meaning to collide with.
  useInput((_input, key) => {
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (focusable.length > 1 && (key.home || key.end)) {
      const total = focusable.length;
      setFocusSlot((s) => (s + (key.home ? total - 1 : 1) % total) % total);
    }
  });

  function handleSubmit(regionId: string, result: unknown) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const outcome: DashboardResult = { regionId, result };
    ipc.sendSelected(outcome);
    exit();
  }

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  const budget = Math.max(
    regions.length * MIN_REGION_ROWS,
    (stdout?.rows ?? 24) - CHROME_ROWS
  );
  const heights = allocateRows(regions, budget);
  const focusedIndex = focusable[Math.min(focusSlot, Math.max(0, focusable.length - 1))];

  return (
    <Box flexDirection="column" key={generation}>
      <Text bold>{config?.title ?? "Dashboard"}</Text>
      {regions.map((region, i) => {
        const focused = i === focusedIndex;
        const rows = heights[i]!;
        return (
          <Box key={region.id} flexDirection="column">
            {renderRegion(region, rows, focused, handleSubmit)}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {focusable.length > 1 ? "Home/End: region  " : ""}
          Esc: close
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Mounts one region's view.
 *
 * Each config is re-validated here rather than trusted: validateDashboard
 * has already rejected the whole config if any region's was bad, so this
 * cannot fail -- but the validators are also what turn an `unknown` config
 * into the typed data a view needs, so calling them is how the region's
 * config gets its type at all.
 */
function renderRegion(
  region: DashboardRegion,
  rows: number,
  focused: boolean,
  onSubmit: (regionId: string, result: unknown) => void
): React.JSX.Element {
  const submit = (result: unknown) => onSubmit(region.id, result);
  switch (region.kind) {
    case "picker": {
      const { options, mode } = validatePicker(region.config as never);
      return (
        <PickerView
          options={options}
          mode={mode}
          title={region.title}
          rows={rows}
          focused={focused}
          onSubmit={submit}
        />
      );
    }
    case "table": {
      const { columns, rows: dataRows } = validateTable(region.config as never);
      return (
        <TableView
          columns={columns}
          rows={dataRows}
          title={region.title}
          budget={rows}
          focused={focused}
        />
      );
    }
    case "form": {
      const { fields } = validateForm(region.config as never);
      return (
        <FormView
          fields={fields}
          title={region.title}
          budget={rows}
          focused={focused}
          onSubmit={submit}
        />
      );
    }
    case "tree": {
      const { nodes } = validateTree(region.config as never);
      return (
        <TreeView
          nodes={nodes}
          title={region.title}
          budget={rows}
          focused={focused}
          onSubmit={submit}
        />
      );
    }
    case "diff": {
      const { files } = parseDiffConfig(region.config as never);
      return (
        <DiffView
          files={files}
          title={region.title}
          budget={rows}
          focused={focused}
          onSubmit={submit}
        />
      );
    }
    case "text": {
      const text = (region.config as { text: string }).text;
      // Unlike every other region kind, a `text` region used to render its
      // full content unconditionally, ignoring the `rows` budget the
      // dashboard's own allocateRows gave it -- a region allocated 4 rows
      // with 12 lines of content rendered all 12, overflowing the terminal
      // and pushing the footer off screen. Windowed here the same way
      // picker/table/tree page their own content: show as many lines as the
      // allocated budget has room for, and when there are more, replace the
      // last visible line with a count of what's hidden rather than
      // overflowing -- the same "(N more)" convention form.tsx's textarea
      // truncation and picker/table/tree's "X of Y" footers use elsewhere in
      // this codebase.
      const lines = text.split("\n");
      const chrome = 2 /* border */ + (region.title ? 1 : 0);
      const available = Math.max(1, rows - chrome);
      const truncated = lines.length > available;
      const shown = truncated ? lines.slice(0, Math.max(0, available - 1)) : lines;
      const hiddenCount = lines.length - shown.length;
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {region.title ? <Text bold>{region.title}</Text> : null}
          {shown.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {truncated ? <Text dimColor>({hiddenCount} more lines)</Text> : null}
        </Box>
      );
    }
  }
}
