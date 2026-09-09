import { resolveGraphics, type GraphicsTier } from "./graphics";

export interface TerminalCapabilities {
  graphics: GraphicsTier;
  trueColor: boolean;
  mouse: boolean;
  columns: number;
  rows: number;
}

export interface PaneSpec {
  argv: string[];
  title: string;
  ratio: number;
}

export interface PaneHandle {
  host: string;
  wtSession?: string;
}

export interface CanvasHost {
  name: string;
  isAvailable(env: NodeJS.ProcessEnv): boolean;
  capabilities(env: NodeJS.ProcessEnv): TerminalCapabilities;
  buildArgv(spec: PaneSpec): string[];
  open(spec: PaneSpec): Promise<PaneHandle>;
}

export function baseCapabilities(env: NodeJS.ProcessEnv): TerminalCapabilities {
  return {
    // Resolved rather than hardcoded since Phase 3. Note that inside a
    // canvas pane this is only correct because `show` writes the tier the
    // controller detected into CANVAS_GRAPHICS before anything reads it --
    // tmux erases the outer terminal's identity, so detection from a pane's
    // own environment can never see past the multiplexer. See host/graphics.ts.
    graphics: resolveGraphics(env),
    trueColor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
    mouse: (env.TERM ?? "").length > 0 || process.platform === "win32",
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
