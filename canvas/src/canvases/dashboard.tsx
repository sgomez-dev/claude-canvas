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
function allocateRows(regions: DashboardRegion[], budget: number): number[] {
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

  // Escape and Tab are the shell's. Escape for the reason every primitive
  // has it in its shell; Tab because focus is a property of the composition,
  // not of any one region.
  useInput((_input, key) => {
    if (key.escape) {
      if (submittedRef.current) return;
      submittedRef.current = true;
      ipc.sendCancelled("escape");
      exit();
      return;
    }
    if (key.tab && focusable.length > 1) {
      const total = focusable.length;
      setFocusSlot((s) => (s + (key.shift ? total - 1 : 1) % total) % total);
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
          {focusable.length > 1 ? "Tab: region  " : ""}
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
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {region.title ? <Text bold>{region.title}</Text> : null}
          <Text>{text}</Text>
        </Box>
      );
    }
  }
}
