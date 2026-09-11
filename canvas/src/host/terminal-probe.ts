/**
 * Finding the terminal on the other side of tmux, by looking instead of asking.
 *
 * Inside tmux the environment lies, and not in the harmless way the rest of
 * this file assumed. A tmux **server** keeps the environment of whichever
 * client started it, and `update-environment` refreshes `TERM` and `DISPLAY`
 * on attach but never `TERM_PROGRAM`. So a server started from Apple
 * Terminal and later attached from WezTerm still reports
 * `TERM_PROGRAM=Apple_Terminal`, and the canvas picks a block tier for a
 * terminal that can do Sixel. Measured on 2026-09-10: exactly that, with the
 * Sixel-capable terminal on screen.
 *
 * Deliberately NOT a terminal query. A DA1 request has to travel back
 * through tmux, may never arrive, and a canvas that hangs on startup is
 * worse than one that paints a lower-fidelity image. This asks the operating
 * system instead: tmux knows the tty its client is attached to, and the
 * process tree above that tty ends at the terminal emulator.
 *
 * Everything here is best-effort by construction. Any failure -- no tmux
 * binary, no attached client, a `ps` that behaves differently, a terminal
 * nobody has heard of -- returns null, and the caller falls back to reading
 * the environment. It can improve a guess; it can never break one.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Executable path on macOS, short name on Linux. Both are matched. */
  command: string;
}

/**
 * The two facts this needs from the outside world, injected so the walk is
 * testable without spawning anything.
 */
export interface ProbeSource {
  /** The tty of the tmux client attached to this pane, or null. */
  clientTty(): string | null;
  /** Every process, for walking parents. */
  processes(): ProcessRow[];
  /** The pids attached to a tty, lowest first. */
  pidsOnTty(tty: string): number[];
}

/**
 * Terminal emulators, matched against the process that owns the client tty's
 * ancestry.
 *
 * Each maps to the environment variables `detectGraphics` already keys off,
 * rather than to a tier directly: the tier mapping lives in exactly one
 * place, and a probe that returned tiers would be a second copy of it that
 * could disagree.
 */
const TERMINALS: Array<{ match: RegExp; env: NodeJS.ProcessEnv }> = [
  { match: /(^|\/)wezterm(-gui)?$/i, env: { TERM_PROGRAM: "WezTerm" } },
  { match: /(^|\/)kitty$/i, env: { TERM: "xterm-kitty" } },
  { match: /(^|\/)ghostty$/i, env: { TERM_PROGRAM: "ghostty" } },
  { match: /(^|\/)iterm2?$/i, env: { TERM_PROGRAM: "iTerm.app" } },
  { match: /(^|\/)foot$/i, env: { TERM: "foot" } },
  { match: /(^|\/)alacritty$/i, env: { TERM_PROGRAM: "Alacritty" } },
  { match: /(^|\/)Terminal$/, env: { TERM_PROGRAM: "Apple_Terminal" } },
  { match: /(^|\/)WindowsTerminal(\.exe)?$/i, env: { WT_SESSION: "probed" } },
];

/** Bounded so a cycle or a pathological tree cannot spin. */
const MAX_DEPTH = 24;

/**
 * The environment the outer terminal *would* have set, or null if it could
 * not be identified.
 *
 * `TERM` is carried over from the real environment rather than invented:
 * `detectGraphics` treats an empty `TERM` as "no terminal at all", and a
 * probe has no business claiming to know it.
 */
export function outerTerminalEnv(
  source: ProbeSource,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv | null {
  let tty: string | null;
  try {
    tty = source.clientTty();
  } catch {
    return null;
  }
  if (tty === null || tty.length === 0) return null;

  let rows: ProcessRow[];
  let seeds: number[];
  try {
    rows = source.processes();
    seeds = source.pidsOnTty(tty);
  } catch {
    return null;
  }
  if (rows.length === 0 || seeds.length === 0) return null;

  const parents = new Map<number, ProcessRow>();
  for (const r of rows) parents.set(r.pid, r);

  // Every pid on the tty, not just the first: `ps` gives no ordering
  // guarantee, and the login shell is not always the row that comes back
  // first. The first recognised ancestor across all of them wins.
  for (const seed of seeds) {
    let current = parents.get(seed);
    for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth++) {
      for (const terminal of TERMINALS) {
        if (terminal.match.test(current.command)) {
          // The matched terminal's OWN `TERM` (kitty and foot each carry
          // one, since they're identified by TERM rather than TERM_PROGRAM)
          // must win over the real environment's, not be overwritten by it.
          // This used to be `{ ...terminal.env, TERM: env.TERM ?? ... }`,
          // an unconditional trailing key that stomped kitty's and foot's
          // own `TERM` with whatever the ambient (usually stale, tmux-set)
          // `TERM` happened to be -- silently downgrading both to the
          // generic fallback tier. See terminal-probe.test.ts for the exact
          // bug shape this is guarding against.
          return { ...terminal.env, TERM: terminal.env.TERM ?? env.TERM ?? "xterm-256color" };
        }
      }
      if (current.ppid <= 1) break;
      const next = parents.get(current.ppid);
      if (next === undefined || next.pid === current.pid) break;
      current = next;
    }
  }
  return null;
}

/** Parses `ps -axo pid=,ppid=,comm=` output. */
export function parseProcesses(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    // Two numeric columns then the command, which itself contains spaces on
    // macOS ("/Applications/Some App.app/..."), so only the first two gaps
    // are separators.
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const command = m[3]!.trim();
    if (command.length === 0) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command });
  }
  return rows;
}

/** Parses `ps -t <tty> -o pid=` output. */
export function parsePids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return "";
  return new TextDecoder().decode(r.stdout);
}

/**
 * The real source: two short-lived local commands, no network and nothing
 * that can block on a terminal's reply.
 */
export const systemProbe: ProbeSource = {
  clientTty() {
    const pane = process.env.TMUX_PANE;
    const argv = pane
      ? ["tmux", "display-message", "-p", "-t", pane, "#{client_tty}"]
      : ["tmux", "display-message", "-p", "#{client_tty}"];
    const out = run(argv).trim();
    return out.length > 0 ? out : null;
  },
  processes() {
    return parseProcesses(run(["ps", "-axo", "pid=,ppid=,comm="]));
  },
  pidsOnTty(tty) {
    // `ps -t` wants the name without /dev/ on macOS and accepts either on
    // Linux, so it is always stripped.
    return parsePids(run(["ps", "-t", tty.replace(/^\/dev\//, ""), "-o", "pid="]));
  },
};
