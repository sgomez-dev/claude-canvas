import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { ImageView } from "./image/view";
import { validateImage, type ImageSource } from "./image/validate";
import { decodePng, type DecodedImage } from "./png";
import type { ImageConfig } from "./image/types";

export interface ImageProps {
  id: string;
  config?: ImageConfig;
  scenario?: string;
  enabled: boolean;
}

/**
 * The image canvas shell.
 *
 * Owns the live config, the file read, the PNG decode, the IPC server,
 * Escape and the single outcome. `ImageView` owns the scaling and knows
 * nothing about any of that.
 *
 * Carries **no `generation` counter**, unlike the four primitives. They
 * remount their view on a pushed config because their interaction state is
 * keyed by field or hunk id, so a missed reset misattributes an answer.
 * `ImageView` holds no state at all -- the image itself lives here, and the
 * effect below replaces it -- so a remount would reset nothing. Verified by
 * sabotage on 2026-09-09: deleting the `key` moved no test, which is what a
 * mechanism that causes nothing looks like. Add one back the moment the view
 * grows state of its own, such as zoom or pan.
 *
 * The decode lives here rather than in the validator because it is the one
 * step that needs I/O: a `path` can only be checked by reading it. So this
 * shell has two error sources -- a config the validator rejected, and a
 * file that turned out not to be a readable PNG -- and reports whichever it
 * has through the same single channel.
 *
 * Renders through the half-block tier for every terminal. Kitty, iTerm2 and
 * Sixel are not implemented yet; when they are, the choice belongs here,
 * because the shell is what already knows the environment. The resolved
 * tier is in `CANVAS_GRAPHICS`, put there by the CLI before rendering --
 * the canvas cannot detect it itself, since inside a tmux pane the outer
 * terminal's identity is erased.
 */
export function Image({
  id,
  config: initialConfig,
  scenario = "display",
  enabled,
}: ImageProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [config, setConfig] = useState<ImageConfig | undefined>(initialConfig);

  const { source, title, background, error } = useMemo(
    () => validateImage(config),
    [config]
  );

  // The decoded image, or the reason it could not be decoded. Both null
  // while the read is in flight, which is the state the "Loading" frame
  // below renders -- a canvas that painted an empty frame during the read
  // would look like a canvas that had failed.
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (source === null) return;
    // Guards against a resolved read landing after the config changed or
    // the canvas unmounted: setting state then would paint the previous
    // image over the current one. The race is real and reachable -- the
    // `await` on the file read is a genuine yield point, so a config pushed
    // during it runs this effect's cleanup and starts a second read while
    // the first is still suspended.
    //
    // **Untested, and the Phase 3 ledger says why.** The only lever on this
    // config is IPC (it lives in state, so a prop change does not reach
    // it), and decodePng is synchronous, so a payload slow enough to
    // overlap also blocks the event loop the IPC needs. Two attempts at a
    // test are recorded there, one of which hung rather than failed. Do not
    // remove this guard on the strength of no test covering it.
    let cancelled = false;
    setImage(null);
    setLoadError(null);
    void (async () => {
      try {
        const bytes =
          source.kind === "data"
            ? source.bytes
            : await Bun.file(source.path).bytes();
        const decoded = decodePng(bytes);
        if (!cancelled) setImage(decoded);
      } catch (e) {
        // The message names the source, because "unsupported colour type 3
        // (palette)" is only actionable if you know which file it was.
        const where = source.kind === "data" ? "inline data" : source.path;
        const why = e instanceof Error ? e.message : String(e);
        if (!cancelled) setLoadError(`image: could not read ${where}: ${why}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const problem = error ?? loadError;

  const submittedRef = useRef(false);
  const sentRef = useRef(false);
  const ipc = useCanvasServer({
    id,
    kind: "image",
    scenario,
    enabled,
    onClose: () => {},
    onUpdate: (next) => {
      setConfig(next as ImageConfig);
      // Deliberately does NOT re-arm sentRef, unlike the four primitives.
      // An error is a terminal outcome: emitOutcome returns early once one
      // exists, so a second report would be dropped by the runtime anyway
      // and re-arming would only make the shell attempt it. The four
      // primitives carry that line and it is equally inert there; see the
      // Phase 3 ledger rather than reading it as a pattern to copy.
    },
  });

  // Reported exactly once, gated on ipc.isConnected because the server
  // starts asynchronously. Depends on `problem` rather than on `error`
  // alone, so a file that is missing or is not a PNG reaches the controller
  // the same way a malformed config does.
  useEffect(() => {
    if (problem !== null && ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(problem);
    }
  }, [problem, ipc.isConnected, ipc.sendError]);

  // Escape is the shell's, always active, and must work from the error and
  // loading states too -- where no view is mounted at all.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    // View-only by design: there is no "selected" outcome, so closing
    // always reports cancelled.
    ipc.sendCancelled("escape");
    exit();
  });

  if (problem !== null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{problem}</Text>
      </Box>
    );
  }

  if (image === null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>{loadingLabel(source)}</Text>
      </Box>
    );
  }

  return (
    <ImageView
      image={image}
      title={title}
      background={background}
      budget={stdout?.rows ?? 24}
      terminalWidth={stdout?.columns ?? 80}
    />
  );
}

function loadingLabel(source: ImageSource | null): string {
  if (source === null) return "Loading…";
  return source.kind === "data" ? "Decoding…" : `Loading ${source.path}…`;
}
