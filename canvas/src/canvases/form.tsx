import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { FormView } from "./form/view";
import { validateForm } from "./form/validate";
import type { FormConfig, FormResult } from "./form/types";

export interface FormProps {
  id: string;
  config?: FormConfig;
  scenario?: string;
  enabled: boolean;
}

/**
 * The form canvas shell.
 *
 * Owns the live config, validation, the IPC server, Escape and the single
 * outcome. `FormView` owns the fields, the focus ring and the
 * missing-required feedback.
 */
export function Form({
  id,
  config: initialConfig,
  scenario = "fill",
  enabled,
}: FormProps): React.JSX.Element {
  const { exit } = useApp();

  // Live config: replaced by an `update` pushed from the controller.
  const [config, setConfig] = useState<FormConfig | undefined>(initialConfig);
  // Remounting the view on a pushed config is how the entered values get
  // cleared.
  //
  // That reset matters: values are keyed by field id, so carrying them over
  // would put a value typed for one field into a differently-typed field
  // that happens to reuse the id. Throwing the component away is exhaustive
  // in a way a hand-written reset is not.
  const [generation, setGeneration] = useState(0);

  const { fields, error } = useMemo(() => validateForm(config), [config]);

  // Guards the outcome. The view only submits a complete form, but Escape
  // can still race a submit.
  const submittedRef = useRef(false);

  const sentRef = useRef(false);
  const ipc = useCanvasServer({
    id,
    kind: "form",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as FormConfig);
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

  // Escape is the shell's, always active, so it works mid-entry and from the
  // config-error state where no view is mounted.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    ipc.sendCancelled("escape");
    exit();
  });

  function handleSubmit(result: FormResult) {
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
    <FormView
      key={generation}
      fields={fields}
      title={config?.title}
      focused
      onSubmit={handleSubmit}
    />
  );
}
