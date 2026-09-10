import { resolveGraphics, type GraphicsTier } from "./graphics";
import { systemProbe } from "./terminal-probe";

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
    // Resolved rather than hardcoded since Phase 3, and probed rather than
    // merely read since the tmux-identity bug.
    //
    // Inside a canvas pane this is right because `show` writes the tier the
    // controller detected into CANVAS_GRAPHICS before anything reads it, and
    // resolveGraphics returns on that override before probing anything. In a
    // CONTROLLER inside tmux there is no override, and the environment is not
    // just blind past the multiplexer -- it can be actively wrong, since a
    // tmux server keeps the environment of whichever client started it. So
    // the probe runs there, and only there. See host/terminal-probe.ts.
    graphics: resolveGraphics(env, undefined, systemProbe),
    trueColor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
    mouse: (env.TERM ?? "").length > 0 || process.platform === "win32",
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
