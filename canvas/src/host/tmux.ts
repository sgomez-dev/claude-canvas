import { baseCapabilities, type CanvasHost, type PaneHandle, type PaneSpec } from "./types";

export const tmuxHost: CanvasHost = {
  name: "tmux",

  isAvailable(env) {
    return Boolean(env.TMUX);
  },

  capabilities(env) {
    return baseCapabilities(env);
  },

  buildArgv(spec: PaneSpec): string[] {
    // -l 67% replaces the deprecated -p 67. "--" keeps payload flags from
    // being parsed by tmux. No shell string anywhere.
    return [
      "tmux",
      "split-window",
      "-h",
      "-l",
      `${Math.round(spec.ratio * 100)}%`,
      "--",
      ...spec.argv,
    ];
  },

  async open(spec: PaneSpec): Promise<PaneHandle> {
    const argv = this.buildArgv(spec);
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tmux split-window failed (${code}): ${err.trim()}`);
    }
    return { host: "tmux" };
  },
};
