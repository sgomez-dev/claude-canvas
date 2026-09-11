import { test, expect, mock } from "bun:test";
import { baseCapabilities } from "./types";
import * as terminalProbeReal from "./terminal-probe";
import type { ProbeSource, ProcessRow } from "./terminal-probe";

// Captured as a PLAIN local, not read back through `terminalProbeReal.
// systemProbe` inside the restore factory below: the namespace import is a
// live binding, so once `mock.module` below has run, `terminalProbeReal.
// systemProbe` itself resolves to the FAKE probe -- restoring with
// `{...terminalProbeReal}` alone would silently reinstall the fake forever,
// leaking it into every test file that runs afterward in this same process.
// This plain variable is captured once, before either test below ever
// mocks anything, so it always names the true original regardless of what
// the module currently resolves to. Same technique, same reason, as
// `originalDecodePng` in test/integration/image.test.tsx.
const realSystemProbe = terminalProbeReal.systemProbe;

// Sabotage-confirmed gap (external review, 2026-09-11): dropping `systemProbe`
// from baseCapabilities's `resolveGraphics(env, undefined, systemProbe)` call
// left the whole suite green -- 610/0 fail -- because every OTHER test here
// either pins CANVAS_GRAPHICS (which short-circuits before the probe is ever
// consulted) or passes an env with no TMUX set (which skips the probe branch
// regardless of whether it was wired in). Nothing exercised the actual
// production wiring, only resolveGraphics called directly with a probe
// argument supplied by the test itself.
//
// This test closes that gap by mocking the REAL systemProbe this module
// imports -- not calling resolveGraphics directly -- so a passing result is
// proof baseCapabilities actually threads it through, not just that
// resolveGraphics knows what to do with one when handed it.

const WEZTERM_TREE: ProcessRow[] = [
  { pid: 72795, ppid: 72794, command: "-zsh" },
  { pid: 73178, ppid: 72795, command: "tmux" },
  { pid: 72794, ppid: 1, command: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" },
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
];

const fakeProbe: ProbeSource = {
  clientTty: () => "/dev/ttys017",
  processes: () => WEZTERM_TREE,
  pidsOnTty: () => [72795, 73178],
};

test("baseCapabilities actually threads systemProbe into resolveGraphics, inside tmux with no override", () => {
  // Deliberately NOT the module's own systemProbe: real systemProbe would
  // spawn actual `tmux`/`ps` processes, which this sandbox (and the CI
  // matrix's Windows runner) does not reliably have. Mocking the whole
  // module -- rather than passing a probe as an argument, which is what the
  // gap in the review was specifically about -- is what makes this a wiring
  // test rather than a restatement of graphics.test.ts's own coverage of
  // resolveGraphics.
  mock.module("./terminal-probe", () => ({
    ...terminalProbeReal,
    systemProbe: fakeProbe,
  }));
  try {
    // TMUX set (required for resolveGraphics to consult a probe at all) and
    // deliberately no TERM_PROGRAM/other markers, so that if the probe is
    // NOT consulted, plain detectGraphics(env) lands on "quadrants" -- a
    // different, equally valid tier from "sixel" (what the mocked WezTerm
    // process tree resolves to) -- making the two cases unmistakable.
    const env = { TMUX: "/tmp/tmux-501/default,1,0", TERM: "xterm-256color" };
    expect(baseCapabilities(env).graphics).toBe("sixel");
  } finally {
    // bun test runs every matched file in one process and mock.module has
    // no direct "unmock" -- restore the real module so no test that runs
    // after this one in the same run sees the fake probe.
    mock.module("./terminal-probe", () => ({ ...terminalProbeReal, systemProbe: realSystemProbe }));
  }
});

test("baseCapabilities never consults the probe outside tmux, override or not", () => {
  mock.module("./terminal-probe", () => ({
    ...terminalProbeReal,
    systemProbe: fakeProbe,
  }));
  try {
    // No TMUX at all: resolveGraphics must fall straight to plain
    // detectGraphics(env), never touching the probe, regardless of whether
    // it is wired in -- the probe branch is gated on TMUX by design (see
    // graphics.ts), and this pins that the fake probe being present at all
    // is not, by itself, enough to change the answer.
    const env = { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" };
    expect(baseCapabilities(env).graphics).toBe("quadrants");
  } finally {
    mock.module("./terminal-probe", () => ({ ...terminalProbeReal, systemProbe: realSystemProbe }));
  }
});
