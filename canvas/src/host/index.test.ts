import { test, expect } from "bun:test";
import { detectHost, NoHostError } from "./index";

test("picks tmux when TMUX is set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0" }).name).toBe("tmux");
});

test("picks wt when WT_SESSION is set", () => {
  expect(detectHost({ WT_SESSION: "abc" }).name).toBe("windows-terminal");
});

test("prefers tmux when both are set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0", WT_SESSION: "abc" }).name).toBe("tmux");
});

test("throws a message naming what was tried when no host is available", () => {
  try {
    detectHost({});
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(NoHostError);
    expect((e as Error).message).toContain("tmux");
    expect((e as Error).message).toContain("Windows Terminal");
  }
});

// This asserted `graphics` is "always none in phase 1", which stopped being
// true in phase 3 and only kept passing because the env it passed had no
// TERM. It then became actively non-deterministic: with TMUX set and no
// override, capabilities now PROBES -- it reads the developer's live tmux
// client and walks the process tree -- so on a machine with WezTerm attached
// it answered "sixel". A unit test must not depend on which terminal the
// person running it happens to have open, the same reason test/setup.ts pins
// TZ, colour and locale.
//
// Both cases below are deterministic by construction: the first because
// CANVAS_GRAPHICS short-circuits before any probing, the second because the
// probe only runs inside tmux and this env is not.
test("capabilities reports the resolved graphics tier", () => {
  expect(
    detectHost({ TMUX: "x" }).capabilities({ TMUX: "x", CANVAS_GRAPHICS: "halfblocks" }).graphics
  ).toBe("halfblocks");

  expect(
    detectHost({ TMUX: "x" }).capabilities({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" })
      .graphics
  ).toBe("quadrants");
});

test("trueColor reads COLORTERM", () => {
  const h = detectHost({ TMUX: "x" });
  expect(h.capabilities({ COLORTERM: "truecolor" }).trueColor).toBe(true);
  expect(h.capabilities({}).trueColor).toBe(false);
});
