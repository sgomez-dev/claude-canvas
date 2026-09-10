import { test, expect } from "bun:test";
import {
  outerTerminalEnv,
  parseProcesses,
  parsePids,
  type ProbeSource,
  type ProcessRow,
} from "./terminal-probe";
import { resolveGraphics } from "./graphics";

/**
 * The two process trees below are not invented. They were read off a real
 * machine on 2026-09-10, from a tmux server started in Apple Terminal and
 * then also attached from WezTerm — which is the exact situation that made
 * this probe necessary.
 */
const APPLE_TERMINAL_TREE: ProcessRow[] = [
  { pid: 61236, ppid: 21446, command: "login" },
  { pid: 61237, ppid: 61236, command: "-zsh" },
  { pid: 68957, ppid: 61237, command: "tmux" },
  { pid: 21446, ppid: 1, command: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
];

const WEZTERM_TREE: ProcessRow[] = [
  { pid: 72795, ppid: 72794, command: "-zsh" },
  { pid: 73178, ppid: 72795, command: "tmux" },
  { pid: 72794, ppid: 1, command: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
];

function source(tty: string | null, rows: ProcessRow[], pids: number[]): ProbeSource {
  return { clientTty: () => tty, processes: () => rows, pidsOnTty: () => pids };
}

const INSIDE_TMUX = { TMUX: "/tmp/tmux-501/default,123,0", TERM: "xterm-256color" };

// --- the walk -------------------------------------------------------------

test("the ancestry of the client tty identifies WezTerm", () => {
  const env = outerTerminalEnv(source("/dev/ttys017", WEZTERM_TREE, [72795, 73178]), INSIDE_TMUX);
  expect(env).toEqual({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color" });
});

test("and identifies Apple Terminal, through the login process", () => {
  const env = outerTerminalEnv(
    source("/dev/ttys015", APPLE_TERMINAL_TREE, [61236, 61237, 68957]),
    INSIDE_TMUX
  );
  expect(env).toEqual({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });
});

// THE bug this exists for, end to end: the environment says one terminal and
// the process tree says another. The tree wins.
test("a stale TERM_PROGRAM loses to what the process tree actually shows", () => {
  const stale = {
    TMUX: "/tmp/tmux-501/default,123,0",
    TERM: "xterm-256color",
    // What the tmux server carried from the client that started it.
    TERM_PROGRAM: "Apple_Terminal",
  };
  expect(resolveGraphics(stale)).toBe("quadrants");
  expect(
    resolveGraphics(stale, undefined, source("/dev/ttys017", WEZTERM_TREE, [72795]))
  ).toBe("sixel");
});

test("every pid on the tty is tried, not only the first one listed", () => {
  // `ps` gives no ordering guarantee, so the terminal may only be reachable
  // from a later row.
  const rows: ProcessRow[] = [
    { pid: 500, ppid: 1, command: "unrelated" },
    { pid: 501, ppid: 502, command: "-zsh" },
    { pid: 502, ppid: 1, command: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
  ];
  expect(outerTerminalEnv(source("/dev/ttys1", rows, [500, 501]), INSIDE_TMUX)).toEqual({
    TERM_PROGRAM: "WezTerm",
    TERM: "xterm-256color",
  });
});

// --- it must never make things worse -------------------------------------

test("an unrecognised terminal returns null so the caller falls back", () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 11, command: "-bash" },
    { pid: 11, ppid: 1, command: "/opt/some-terminal-nobody-has-heard-of" },
  ];
  expect(outerTerminalEnv(source("/dev/ttys9", rows, [10]), INSIDE_TMUX)).toBeNull();
});

test("a source that throws is a fallback, not a crash", () => {
  const boom: ProbeSource = {
    clientTty() {
      throw new Error("no tmux binary");
    },
    processes: () => [],
    pidsOnTty: () => [],
  };
  expect(outerTerminalEnv(boom, INSIDE_TMUX)).toBeNull();
  expect(resolveGraphics(INSIDE_TMUX, undefined, boom)).toBe("quadrants");
});

test("no attached client, no processes, or no pids all return null", () => {
  expect(outerTerminalEnv(source(null, WEZTERM_TREE, [1]), INSIDE_TMUX)).toBeNull();
  expect(outerTerminalEnv(source("/dev/ttys1", [], [1]), INSIDE_TMUX)).toBeNull();
  expect(outerTerminalEnv(source("/dev/ttys1", WEZTERM_TREE, []), INSIDE_TMUX)).toBeNull();
});

// A cycle in the parent chain would spin forever without the bound.
test("a cycle in the process tree terminates", () => {
  const rows: ProcessRow[] = [
    { pid: 1000, ppid: 1001, command: "a" },
    { pid: 1001, ppid: 1000, command: "b" },
  ];
  expect(outerTerminalEnv(source("/dev/ttys1", rows, [1000]), INSIDE_TMUX)).toBeNull();
});

// The probe only runs inside tmux: outside it the environment is the truth,
// and spawning `ps` on every resolve would be waste.
test("outside tmux the probe is not consulted at all", () => {
  let consulted = false;
  const spy: ProbeSource = {
    clientTty() {
      consulted = true;
      return "/dev/ttys017";
    },
    processes: () => WEZTERM_TREE,
    pidsOnTty: () => [72795],
  };
  expect(resolveGraphics({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }, undefined, spy)).toBe(
    "quadrants"
  );
  expect(consulted).toBe(false);
});

// An explicit answer always beats a probed one.
test("CANVAS_GRAPHICS and --graphics still win over the probe", () => {
  const s = source("/dev/ttys017", WEZTERM_TREE, [72795]);
  expect(resolveGraphics({ ...INSIDE_TMUX, CANVAS_GRAPHICS: "halfblocks" }, undefined, s)).toBe(
    "halfblocks"
  );
  expect(resolveGraphics(INSIDE_TMUX, "kitty", s)).toBe("kitty");
});

test("TERM is carried from the real environment, never invented", () => {
  const env = outerTerminalEnv(source("/dev/ttys017", WEZTERM_TREE, [72795]), {
    TMUX: "x,1,0",
    TERM: "tmux-256color",
  });
  expect(env?.TERM).toBe("tmux-256color");
});

// --- parsing --------------------------------------------------------------

// macOS prints the full executable path, which contains spaces, so only the
// first two gaps are column separators.
test("ps output parses paths containing spaces", () => {
  const rows = parseProcesses(
    "  61236 21446 login\n 21446     1 /Applications/Some App.app/Contents/MacOS/Some App\n\ngarbage\n"
  );
  expect(rows).toEqual([
    { pid: 61236, ppid: 21446, command: "login" },
    { pid: 21446, ppid: 1, command: "/Applications/Some App.app/Contents/MacOS/Some App" },
  ]);
});

test("pid lists ignore blank and non-numeric lines", () => {
  expect(parsePids(" 61236\n\n 61237 \nnope\n0\n-3\n")).toEqual([61236, 61237]);
});
