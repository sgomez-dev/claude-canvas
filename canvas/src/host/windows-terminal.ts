import { baseCapabilities, type CanvasHost, type PaneHandle, type PaneSpec } from "./types";

export const windowsTerminalHost: CanvasHost = {
  name: "windows-terminal",

  isAvailable(env) {
    return Boolean(env.WT_SESSION);
  },

  capabilities(env) {
    return baseCapabilities(env);
  },

  buildArgv(spec: PaneSpec): string[] {
    // Defence in depth. Callers already validate id/kind/scenario against
    // ^[A-Za-z0-9_-]{1,64}$, but any semicolon reaching wt is an injection
    // into wt's own command grammar regardless of quoting, so refuse here too.
    for (const arg of spec.argv) {
      if (arg.includes(";")) {
        throw new Error(
          "Refusing to invoke wt.exe with an argument containing a semicolon: " +
            "wt splits its own command line on ';' even inside quoted arguments."
        );
      }
    }
    return [
      "wt.exe",
      "-w",
      "0", // mandatory: target the caller's existing window
      "split-pane",
      "-V", // side-by-side
      "--size",
      spec.ratio.toFixed(2),
      ...spec.argv,
    ];
  },

  async open(spec: PaneSpec): Promise<PaneHandle> {
    const argv = this.buildArgv(spec);
    // wt.exe is a GUI app: it returns 0 immediately and writes zero bytes to
    // stdout and stderr on every invocation, wt --help included. There is no
    // handle to capture and no close verb. The canvas closes its own pane by
    // exiting 0; see the lifecycle section of the spec.
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`wt.exe split-pane failed with exit code ${code}`);
    return { host: "windows-terminal", wtSession: process.env.WT_SESSION };
  },
};
