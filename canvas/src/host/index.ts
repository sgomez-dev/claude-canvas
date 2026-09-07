import type { CanvasHost } from "./types";
import { tmuxHost } from "./tmux";
import { windowsTerminalHost } from "./windows-terminal";

export * from "./types";

export class NoHostError extends Error {
  constructor() {
    super(
      "No canvas host available. Tried tmux (needs $TMUX — start a tmux session) " +
        "and Windows Terminal (needs $WT_SESSION — run inside Windows Terminal)."
    );
    this.name = "NoHostError";
  }
}

const HOSTS: CanvasHost[] = [tmuxHost, windowsTerminalHost];

export function detectHost(env: NodeJS.ProcessEnv = process.env): CanvasHost {
  const host = HOSTS.find((h) => h.isAvailable(env));
  if (!host) throw new NoHostError();
  return host;
}
