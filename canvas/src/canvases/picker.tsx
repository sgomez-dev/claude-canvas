import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { PickerView } from "./picker/view";
import { validatePicker } from "./picker/validate";
import type { PickerConfig, PickerResult } from "./picker/types";

export interface PickerProps {
  id: string;
  config?: PickerConfig;
  scenario?: string;
  enabled: boolean;
}

/**
 * The picker canvas shell.
 *
 * Owns everything that is not rendering: the live config, validation, the
 * IPC server, Escape, and the single outcome. `PickerView` owns the list and
 * its cursor. The split is what lets a composed canvas embed the view
 * without inheriting a second IPC server or a second outcome.
 */
export function Picker({
  id,
  config: initialConfig,
  scenario = "select",
  enabled,
}: PickerProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Live config: replaced by an `update` pushed from the controller.
  const [config, setConfig] = useState<PickerConfig | undefined>(initialConfig);
  // Bumped on every pushed config, and used as the view's React key.
  //
  // Remounting the view is how the interaction state gets reset, replacing
  // the effect that used to clear the cursor and the checked set by hand. A
  // pushed config is a new question, so every piece of state that referred
  // to the old one has to go -- and "throw the component away" is both
  // exhaustive and impossible to get half-right, which a hand-written reset
  // is not.
  const [generation, setGeneration] = useState(0);

  const { options, mode, error } = useMemo(() => validatePicker(config), [config]);

  // Guards the outcome, not the input: `PickerView` may call onSubmit more
  // than once (Enter-then-Enter within a tick), and Escape can race a
  // submit. First outcome wins.
  const submittedRef = useRef(false);

  const sentRef = useRef(false);
  const ipc = useCanvasServer({
    id,
    kind: "picker",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as PickerConfig);
      setGeneration((g) => g + 1);
      // So a config error in the NEW config is reported too.
      sentRef.current = false;
    },
  });

  // Reports a config validation failure to the controller exactly once, when
  // `error` transitions from null to non-null. Gated on `ipc.isConnected`
  // because the IPC server starts asynchronously (real filesystem I/O for
  // the registry record), so an unconditional send on mount would race its
  // startup. Retained outcomes mean the controller still receives it even
  // though it is sent before any controller can have connected.
  useEffect(() => {
    if (error && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(error);
    }
  }, [error, ipc.isConnected, ipc.sendError]);

  // Escape is the shell's, always active, and checked before anything else
  // so the pane is never un-exitable by keyboard -- including from the
  // config-error state, where no view is mounted at all.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    ipc.sendCancelled("escape");
    exit();
  });

  function handleSubmit(result: PickerResult) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    ipc.sendSelected(result);
    exit();
  }

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  return (
    <PickerView
      key={generation}
      options={options}
      mode={mode}
      title={config?.title}
      prompt={config?.prompt}
      rows={stdout?.rows ?? 24}
      columns={stdout?.columns ?? 80}
      focused
      onSubmit={handleSubmit}
    />
  );
}
