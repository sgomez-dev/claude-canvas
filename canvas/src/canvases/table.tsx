import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { TableView } from "./table/view";
import { validateTable } from "./table/validate";
import type { TableConfig } from "./table/types";

export interface TableProps {
  id: string;
  config?: TableConfig;
  scenario?: string;
  enabled: boolean;
}

/**
 * The table canvas shell.
 *
 * Owns the live config, validation, the IPC server, Escape and the single
 * outcome. `TableView` owns the grid and its scroll. The split is what lets
 * a composed canvas embed the view without inheriting a second IPC server.
 */
export function Table({
  id,
  config: initialConfig,
  scenario = "display",
  enabled,
}: TableProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Live config: replaced by an `update` pushed from the controller. This is
  // the primitive most likely to receive one -- refreshing a table's rows in
  // place is the obvious use for server-push.
  const [config, setConfig] = useState<TableConfig | undefined>(initialConfig);
  // Remounting the view on a pushed config is how the scroll offset resets;
  // see picker.tsx for why that beats a hand-written reset.
  const [generation, setGeneration] = useState(0);

  const { columns, rows, error } = useMemo(() => validateTable(config), [config]);

  // Guards the outcome. `table` is view-only, so the only outcome it ever
  // produces is the `cancelled` below -- but a second Escape must not send a
  // second one.
  const submittedRef = useRef(false);

  const sentRef = useRef(false);
  const ipc = useCanvasServer({
    id,
    kind: "table",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as TableConfig);
      setGeneration((g) => g + 1);
      sentRef.current = false;
    },
  });

  // Reports a config error exactly once, gated on ipc.isConnected because
  // the server starts asynchronously. See picker.tsx for the full reasoning.
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  // Escape is the shell's, always active, and works even from the
  // config-error state where no view is mounted.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    // View-only by design: there is no "selected" outcome, so closing always
    // reports cancelled.
    ipc.sendCancelled("escape");
    exit();
  });

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  return (
    <TableView
      key={generation}
      columns={columns}
      rows={rows}
      title={config?.title}
      budget={stdout?.rows ?? 24}
      terminalWidth={stdout?.columns ?? 80}
      focused
    />
  );
}
