import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { ImageView } from "./image/view";
import { GraphicsImageView } from "./image/graphics-view";
import { validateImage, type ImageSource } from "./image/validate";
import { decodePng, type DecodedImage } from "./png";
import { resolveGraphics } from "../host/graphics";
import { resolveCellPixels, CELL_PIXELS } from "./graphics/sixel";
import { usesProtocol } from "./graphics/paint";
import { imageIdFor } from "./graphics/kitty";
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
 * Picks the tier and therefore the view. `halfblocks` renders through Ink
 * as styled text; kitty, iTerm2 and Sixel reserve rows and paint with a
 * terminal protocol. The resolved tier comes from `CANVAS_GRAPHICS`, put
 * there by the CLI before rendering -- the canvas cannot detect it itself,
 * since inside a tmux pane the outer terminal's identity is erased.
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

  // Derived once from this canvas's own id, not regenerated per render or
  // per repaint: two `image` panes open side by side are a supported flow,
  // and kitty's placements are scoped by this number, not by anything Ink
  // or the terminal already keeps separate. Without a STABLE, per-instance
  // id, one canvas's own repaint-triggered clear (`encodeKittyClear`) would
  // either target nothing (a fresh id every time) or, with the old
  // "delete everything" directive this replaces, wipe the other canvas's
  // image too.
  const imageId = useMemo(() => imageIdFor(id), [id]);

  const { source, title, background, error } = useMemo(
    () => validateImage(config),
    [config]
  );

  // The tier and the cell assumption, both of which can be rejected: a
  // misspelled CANVAS_GRAPHICS or CANVAS_CELL_PIXELS throws rather than
  // being ignored, because someone who set it meant something by it. Caught
  // here so it reaches the same single error channel as a bad config
  // instead of taking the canvas down mid-render with no message.
  const environment = useMemo(() => {
    try {
      return {
        tier: resolveGraphics(process.env),
        cell: resolveCellPixels(process.env),
        error: null as string | null,
      };
    } catch (e) {
      return {
        tier: "halfblocks" as const,
        cell: CELL_PIXELS,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, []);

  // The decoded image AND the bytes it came from. kitty and iTerm2 send the
  // PNG itself and let the terminal decode it, which for this repository's
  // own screenshot is 2 MB rather than the 39 MB its RGBA would base64 to --
  // so the original bytes are worth keeping, not just the pixels.
  const [png, setPng] = useState<Uint8Array | null>(null);
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (source === null) return;
    // Guards against a resolved read landing after the config changed or
    // the canvas unmounted: setting state then would paint the previous
    // image over the current one. The race is real and reachable -- the
    // `await` on the file read is a genuine yield point, so a config pushed
    // during it runs this effect's cleanup and starts a second read while
    // the first is still suspended. Checked immediately after that `await`
    // and BEFORE `decodePng` runs, not merely before the `setState` calls
    // that use its result: `decodePng` is synchronous and can take hundreds
    // of milliseconds on a large image, so a superseded read that decoded
    // anyway would still pay that cost in full -- fully blocking the event
    // loop the IPC server needs to read its socket, and blocking Escape --
    // for a result about to be thrown away. Checking first skips the decode
    // entirely instead of merely discarding its output.
    //
    // Tested: see "a superseded read's bytes never reach decodePng, not
    // merely its result" in canvas/test/integration/image.test.tsx (this
    // repo has two files named image.test.tsx -- the other, under
    // test/snapshots/, covers unrelated rendering cases). That test wraps
    // `decodePng` via `mock.module` and asserts on its own call arguments,
    // not just the final rendered frame -- an earlier regression test in
    // the same file ("a config pushed while a large image is still loading
    // does not lose to a stale, late-arriving read") only ever checked the
    // frame, which the weaker post-decode `if (!cancelled)` guard below was
    // already enough to guarantee; reverting just this earlier check did
    // not make it fail. The earlier claim here that this was "structurally
    // untestable" was also wrong -- the reachable yield point is the async
    // file read above, not `decodePng`'s synchronicity; pushing a second,
    // smaller config while a large image's read is still in flight
    // reproduces the race directly.
    let cancelled = false;
    setImage(null);
    setPng(null);
    setLoadError(null);
    void (async () => {
      try {
        const bytes =
          source.kind === "data"
            ? source.bytes
            : await Bun.file(source.path).bytes();
        if (cancelled) return;
        const decoded = decodePng(bytes);
        if (!cancelled) {
          setPng(bytes);
          setImage(decoded);
        }
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

  const problem = error ?? environment.error ?? loadError;

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

  if (image === null || png === null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>{loadingLabel(source)}</Text>
      </Box>
    );
  }

  if (usesProtocol(environment.tier)) {
    return (
      <GraphicsImageView
        image={image}
        png={png}
        tier={environment.tier}
        title={title}
        background={background}
        budget={stdout?.rows ?? 24}
        terminalWidth={stdout?.columns ?? 80}
        cell={environment.cell}
        imageId={imageId}
      />
    );
  }

  return (
    <ImageView
      image={image}
      // Every non-protocol tier lands here, so `none` renders half-blocks
      // too: there is no terminal to paint into in that case, and the
      // narrower font requirement is the better thing to fall back on.
      mode={environment.tier === "quadrants" ? "quadrants" : "halfblocks"}
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
