import { test, expect } from "bun:test";
import { detectGraphics, resolveGraphics, isGraphicsTier } from "./graphics";

// A minimal environment that is a real terminal but announces nothing.
const plain = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  TERM: "xterm-256color",
  ...over,
});

test("no terminal at all is 'none', not a paintable tier", () => {
  expect(detectGraphics({})).toBe("none");
  expect(detectGraphics({ TERM: "" })).toBe("none");
  expect(detectGraphics({ TERM: "dumb" })).toBe("none");
});

test("kitty and Ghostty get the kitty protocol", () => {
  expect(detectGraphics(plain({ KITTY_WINDOW_ID: "1" }))).toBe("kitty");
  expect(detectGraphics({ TERM: "xterm-kitty" })).toBe("kitty");
  expect(detectGraphics(plain({ TERM_PROGRAM: "ghostty" }))).toBe("kitty");
  expect(detectGraphics(plain({ GHOSTTY_RESOURCES_DIR: "/x" }))).toBe("kitty");
});

// iTerm2 supports Sixel too, but its own protocol is higher fidelity, so it
// must not be folded into the sixel tier.
test("iTerm2 gets its own tier, not sixel", () => {
  expect(detectGraphics(plain({ TERM_PROGRAM: "iTerm.app" }))).toBe("iterm2");
  expect(detectGraphics(plain({ LC_TERMINAL: "iTerm2" }))).toBe("iterm2");
});

test("WezTerm, foot and Windows Terminal get sixel", () => {
  expect(detectGraphics(plain({ TERM_PROGRAM: "WezTerm" }))).toBe("sixel");
  expect(detectGraphics(plain({ WEZTERM_EXECUTABLE: "/x/wezterm" }))).toBe("sixel");
  expect(detectGraphics({ TERM: "foot" })).toBe("sixel");
  expect(detectGraphics({ TERM: "foot-extra" })).toBe("sixel");
  expect(detectGraphics(plain({ WT_SESSION: "abc" }))).toBe("sixel");
});

// THE real-world case: native PowerShell or cmd.exe running inside Windows
// Terminal. `TERM` is a POSIX convention -- these shells never set it, with
// or without Windows Terminal hosting them. Every other test in this file
// that exercises WT_SESSION goes through the `plain()` helper, which injects
// `TERM: "xterm-256color"` -- masking exactly this case, since the
// WT_SESSION branch was reachable only when TERM already had *something* in
// it. This test constructs the environment raw, with WT_SESSION set and NO
// TERM at all, to pin the actual maintainer-machine scenario.
test("Windows Terminal is detected even with no TERM set at all (native PowerShell/cmd.exe)", () => {
  expect(detectGraphics({ WT_SESSION: "abc" })).toBe("sixel");
  // TERM=dumb alongside WT_SESSION: the Windows-specific signal still wins.
  expect(detectGraphics({ WT_SESSION: "abc", TERM: "dumb" })).toBe("sixel");
  // Without WT_SESSION, an empty/absent TERM is still correctly "none".
  expect(detectGraphics({})).toBe("none");
  expect(detectGraphics({ TERM: "dumb" })).toBe("none");
});

// THE trap. Apple Terminal sets TERM=xterm-256color and supports no image
// protocol at all; so do plenty of other emulators, and xterm's own Sixel
// support is patch-dependent and a compile-time option. Inferring sixel
// from TERM would emit escapes that render as garbage.
test("TERM=xterm* alone never implies sixel", () => {
  expect(detectGraphics({ TERM: "xterm-256color" })).toBe("halfblocks");
  expect(detectGraphics({ TERM: "xterm" })).toBe("halfblocks");
  expect(detectGraphics(plain({ TERM_PROGRAM: "Apple_Terminal" }))).toBe("halfblocks");
});

test("terminals with no protocol fall to halfblocks, the baseline", () => {
  expect(detectGraphics(plain({ TERM_PROGRAM: "Apple_Terminal" }))).toBe("halfblocks");
  expect(detectGraphics(plain({ TERM_PROGRAM: "vscode" }))).toBe("halfblocks");
  expect(detectGraphics({ TERM: "alacritty" })).toBe("halfblocks");
});

// Measured 2026-09-09: inside tmux, TERM_PROGRAM becomes "tmux" and TERM
// becomes "tmux-256color". The outer terminal's identity is ERASED, not
// merely obscured -- so a canvas in a pane detects nothing useful about the
// terminal it is actually drawing to, and the controller must pass the
// answer down. This test pins the fact that makes that necessary.
test("inside tmux the outer terminal is invisible, so detection degrades to the baseline", () => {
  const insideTmux = {
    TERM: "tmux-256color",
    TERM_PROGRAM: "tmux",
    TERM_PROGRAM_VERSION: "3.7c",
    COLORTERM: "truecolor",
  };
  // Even if the OUTER terminal were kitty or WezTerm, this is all a canvas
  // in the pane can see.
  expect(detectGraphics(insideTmux)).toBe("halfblocks");
});

// --- resolveGraphics -----------------------------------------------------

test("the controller's answer is used when the canvas cannot detect anything", () => {
  const insideTmux = { TERM: "tmux-256color", TERM_PROGRAM: "tmux" };
  expect(resolveGraphics(insideTmux, "sixel")).toBe("sixel");
  expect(resolveGraphics(insideTmux, "kitty")).toBe("kitty");
  // Without it, the pane is stuck with the baseline.
  expect(resolveGraphics(insideTmux)).toBe("halfblocks");
});

test("CANVAS_GRAPHICS overrides both detection and the controller", () => {
  expect(resolveGraphics(plain({ CANVAS_GRAPHICS: "halfblocks" }), "sixel")).toBe("halfblocks");
  expect(resolveGraphics(plain({ CANVAS_GRAPHICS: "sixel", KITTY_WINDOW_ID: "1" }))).toBe("sixel");
  // The escape hatch for an old Windows Terminal that would render Sixel as
  // garbage: WT_SESSION says sixel, the user says otherwise, user wins.
  expect(resolveGraphics(plain({ WT_SESSION: "a", CANVAS_GRAPHICS: "halfblocks" }))).toBe(
    "halfblocks"
  );
});

test("an empty override is ignored rather than treated as a tier", () => {
  expect(resolveGraphics(plain({ CANVAS_GRAPHICS: "", KITTY_WINDOW_ID: "1" }))).toBe("kitty");
  expect(resolveGraphics(plain({ KITTY_WINDOW_ID: "1" }), "")).toBe("kitty");
});

// A typo'd override is reported, not silently ignored: someone who set it
// meant something by it, and falling back would paint the wrong tier while
// telling them nothing.
test("a misspelled override or argument is rejected, naming the valid tiers", () => {
  expect(() => resolveGraphics(plain({ CANVAS_GRAPHICS: "sixl" }))).toThrow(
    /Invalid CANVAS_GRAPHICS: "sixl".*kitty, iterm2, sixel, halfblocks, none/
  );
  expect(() => resolveGraphics(plain(), "blocks")).toThrow(
    /Invalid --graphics: "blocks".*halfblocks/
  );
});

test("isGraphicsTier accepts exactly the five tiers", () => {
  for (const t of ["kitty", "iterm2", "sixel", "halfblocks", "none"]) {
    expect(isGraphicsTier(t)).toBe(true);
  }
  for (const t of ["Sixel", "half-blocks", "", undefined, null, 3]) {
    expect(isGraphicsTier(t)).toBe(false);
  }
});
