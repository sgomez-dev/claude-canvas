export interface TerminalCapabilities {
  graphics: "kitty" | "iterm2" | "sixel" | "none";
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

// Phase 1 implements only what is free. Probing for Kitty, iTerm2 or Sixel
// support is Phase 3 work and must not be attempted here.
export function baseCapabilities(env: NodeJS.ProcessEnv): TerminalCapabilities {
  return {
    graphics: "none",
    trueColor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
    mouse: (env.TERM ?? "").length > 0 || process.platform === "win32",
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
