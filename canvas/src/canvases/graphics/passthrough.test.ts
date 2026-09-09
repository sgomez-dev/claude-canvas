import { test, expect } from "bun:test";
import { wrapPassthrough, needsPassthrough, forTerminal } from "./passthrough";

const ESC = "\x1b";

test("the payload is wrapped in a tmux DCS", () => {
  const out = wrapPassthrough("hello");
  expect(out).toBe(`${ESC}Ptmux;hello${ESC}\\`);
});

// The load-bearing rule. An un-doubled ESC ends the passthrough at the first
// one, so the rest of the payload lands on screen as literal text.
test("every ESC in the payload is doubled", () => {
  const out = wrapPassthrough(`${ESC}_Gx;y${ESC}\\`);
  expect(out).toBe(`${ESC}Ptmux;${ESC}${ESC}_Gx;y${ESC}${ESC}\\${ESC}\\`);
  // The DCS's own terminator is NOT doubled: exactly one trailing ESC-\.
  expect(out.endsWith(`${ESC}${ESC}\\${ESC}\\`)).toBe(true);
});

test("a payload with many escapes doubles all of them", () => {
  const out = wrapPassthrough(`a${ESC}b${ESC}c${ESC}`);
  const body = out.slice(`${ESC}Ptmux;`.length, -2);
  expect(body).toBe(`a${ESC}${ESC}b${ESC}${ESC}c${ESC}${ESC}`);
});

// TMUX, not TERM_PROGRAM: tmux overwrites TERM_PROGRAM with its own name, so
// that variable cannot tell "inside tmux" from "a terminal called tmux".
test("passthrough is needed exactly when TMUX is set", () => {
  expect(needsPassthrough({ TMUX: "/tmp/tmux-501/default,123,0" } as never)).toBe(true);
  expect(needsPassthrough({} as never)).toBe(false);
  expect(needsPassthrough({ TMUX: "" } as never)).toBe(false);
  expect(needsPassthrough({ TERM_PROGRAM: "tmux" } as never)).toBe(false);
});

test("outside tmux the escapes are emitted untouched", () => {
  const parts = [`${ESC}_Ga;1${ESC}\\`, `${ESC}_Gm=0;2${ESC}\\`];
  expect(forTerminal(parts, {} as never)).toBe(parts.join(""));
});

// Each escape gets its own DCS rather than one wrapping the concatenation:
// a single DCS carrying a multi-megabyte image is a single buffer for tmux
// to hold whole.
test("inside tmux each escape is wrapped separately", () => {
  const parts = [`${ESC}_Ga;1${ESC}\\`, `${ESC}_Gm=0;2${ESC}\\`];
  const out = forTerminal(parts, { TMUX: "x,1,0" } as never);
  expect(out.split(`${ESC}Ptmux;`).length - 1).toBe(2);
  expect(out).toBe(parts.map(wrapPassthrough).join(""));
});
