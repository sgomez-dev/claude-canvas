import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { DiffView } from "./diff/view";
import { parseDiffConfig } from "./diff/validate";
import type { DiffReviewConfig, DiffReviewResult } from "./diff/types";

export interface DiffProps {
  id: string;
  config?: DiffReviewConfig;
  scenario?: string;
  enabled: boolean;
}

/**
 * The diff review canvas shell.
 *
 * Owns the live config, parsing, the IPC server, Escape and the single
 * outcome. `DiffView` owns the file list, the hunk body and the decisions.
 */
export function Diff({
  id,
  config: initialConfig,
  scenario = "review",
  enabled,
}: DiffProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Live config: replaced by an `update` pushed from the controller.
  const [config, setConfig] = useState<DiffReviewConfig | undefined>(initialConfig);
  // Remounting the view on a pushed config is how the decisions get cleared.
  //
  // That reset is not cosmetic: decisions are keyed by hunk id, and an id
  // from the previous diff can collide with an unrelated hunk in the new one
  // -- same path plus same hunk index means the same id -- so carrying them
  // over would apply an "approved" to code the user never saw. Throwing the
  // component away is exhaustive in a way a hand-written reset is not.
  const [generation, setGeneration] = useState(0);

  const { files, error } = useMemo(() => parseDiffConfig(config), [config]);

  // Guards the outcome. The view may call onSubmit more than once
  // (Enter-then-Enter within a tick), and Escape can race a submit.
  const submittedRef = useRef(false);

  const sentRef = useRef(false);
  const ipc = useCanvasServer({
    id,
    kind: "diff",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as DiffReviewConfig);
      setGeneration((g) => g + 1);
      sentRef.current = false;
    },
  });

  // Reports a parse failure exactly once, gated on ipc.isConnected because
  // the server starts asynchronously. Retained outcomes mean the controller
  // receives it even though it is sent before any controller can connect --
  // which is what made this assertion possible at all.
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  // Escape is the shell's, always active, and works from the parse-error
  // state where no view is mounted at all -- the regression this ordering
  // was written for.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    ipc.sendCancelled("escape");
    exit();
  });

  function handleSubmit(result: DiffReviewResult) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    ipc.sendSelected(result);
    exit();
  }

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">Failed to parse diff: {error}</Text>
      </Box>
    );
  }

  return (
    <DiffView
      key={generation}
      files={files}
      title={config?.title}
      budget={stdout?.rows ?? 24}
      columns={stdout?.columns ?? 80}
      focused
      onSubmit={handleSubmit}
    />
  );
}
