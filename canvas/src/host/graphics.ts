import { outerTerminalEnv, type ProbeSource } from "./terminal-probe";

/**
 * Which image protocol a terminal can render.
 *
 * `halfblocks` is the baseline, not a fallback of last resort: Apple
 * Terminal ships as macOS's default with no protocol at all, and kitty,
 * Ghostty and Alacritty all refuse Sixel on principle. A design that treats
 * a graphics protocol as the normal path gets the common case backwards.
 * `none` means there is no usable terminal at all.
 */
export type GraphicsTier =
  | "kitty"
  | "iterm2"
  | "sixel"
  | "quadrants"
  | "halfblocks"
  | "none";

export const GRAPHICS_TIERS: readonly GraphicsTier[] = [
  "kitty",
  "iterm2",
  "sixel",
  "quadrants",
  "halfblocks",
  "none",
];

export function isGraphicsTier(value: unknown): value is GraphicsTier {
  return typeof value === "string" && (GRAPHICS_TIERS as readonly string[]).includes(value);
}

/**
 * Detects the tier from environment variables.
 *
 * **This only works OUTSIDE a canvas pane.** Measured 2026-09-09: inside
 * tmux, `TERM_PROGRAM` becomes `tmux` and `TERM` becomes `tmux-256color` --
 * the outer terminal's identity is erased entirely, not merely obscured. So
 * a canvas spawned into a pane cannot detect anything itself, and the
 * controller (which runs in the user's own shell, where the real values are
 * still present) has to detect and pass the answer down. `spawn` does that
 * with a `--graphics` argument; see resolveGraphics.
 *
 * Deliberately **no terminal interrogation**. The correct way to ask a
 * terminal what it supports is a DA1 query, and the reply has to travel back
 * through tmux, which may or may not pass it. A probe that gets no answer
 * either strands the canvas waiting or has to time out, and a canvas that
 * hangs on startup is worse than one that paints a lower-fidelity image.
 */
export function detectGraphics(env: NodeJS.ProcessEnv): GraphicsTier {
  const program = env.TERM_PROGRAM ?? "";
  const term = env.TERM ?? "";

  // No terminal at all: nothing can be painted, not even blocks. Windows
  // Terminal is exempted from this bailout: `TERM` is a POSIX convention,
  // and native Windows shells (PowerShell, cmd.exe) never set it at all --
  // with or without Windows Terminal hosting them. `WT_SESSION` is checked
  // independently below and is the one signal that survives that gap, so an
  // empty/absent `TERM` must not short-circuit past it. (The `mouse`
  // capability in host/types.ts hit the same gap and takes the same
  // approach: check the Windows-specific signal independently of TERM.)
  if ((term.length === 0 || term === "dumb") && env.WT_SESSION === undefined) return "none";

  // --- Kitty's own protocol, which is better than Sixel where both exist.
  // Ghostty implements it and refuses Sixel, so it belongs here too.
  if (env.KITTY_WINDOW_ID !== undefined || term === "xterm-kitty") return "kitty";
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR !== undefined) return "kitty";

  // --- iTerm2 supports Sixel as well, but its own inline-image protocol is
  // higher fidelity, so it gets its own tier rather than being folded in.
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm2";

  // --- Sixel, by explicit program marker only.
  //
  // NOT by `TERM=xterm*`. That is the trap: Apple Terminal sets
  // `TERM=xterm-256color` and supports no protocol whatsoever, as do many
  // other emulators, and xterm's own Sixel support is both patch-dependent
  // and a compile-time option. Inferring from TERM would emit Sixel escapes
  // into terminals that render them as garbage, which is a far worse
  // failure than painting blocks.
  if (program === "WezTerm" || env.WEZTERM_EXECUTABLE !== undefined) return "sixel";
  if (term === "foot" || term === "foot-extra") return "sixel";
  // Windows Terminal. `WT_SESSION` is present in every version and there is
  // no version variable, so this cannot distinguish 1.22+ (which has Sixel)
  // from older builds (which do not). Treated as capable because 1.22
  // shipped in 2024 and the alternative penalises every current install for
  // the sake of stale ones -- an old Windows Terminal will show garbage and
  // needs `CANVAS_GRAPHICS=halfblocks`, which is documented. Checked here,
  // not folded into the empty-TERM bailout above, precisely because that
  // bailout must not fire for `WT_SESSION` sessions with no `TERM` (native
  // PowerShell/cmd.exe inside Windows Terminal never set `TERM` at all).
  if (env.WT_SESSION !== undefined) return "sixel";

  // --- Known to have NO protocol, listed explicitly so the reasoning is
  // recorded rather than falling through silently: Apple Terminal has none,
  // Alacritty rejected Sixel upstream, and VS Code's support is behind a
  // setting we cannot read from here (`terminal.integrated.enableImages`),
  // so it gets a block-character tier and the override.
  //
  // `quadrants`, not `halfblocks`: 2x2 pixels per cell instead of 1x2, which
  // measured 61% less error on this repository's own screenshot. The cost is
  // a slightly larger font requirement, and it CANNOT be detected -- nothing
  // a terminal reports says which glyphs its font has.
  //
  // Measured on macOS 26.6 (2026-09-10) by reading the fonts' own cmap
  // tables: Menlo and SF Mono, which covers Terminal.app's default and its
  // most common alternative, both carry the full quadrant set. Courier New
  // carries the half blocks but not the quadrants, and Monaco carries
  // neither -- so a Monaco user was already seeing nothing under the old
  // default. Cost if wrong: empty boxes instead of an image, which is
  // obvious rather than subtly wrong, and `CANVAS_GRAPHICS=halfblocks`
  // fixes it in one variable. That is documented in the image skill.
  return "quadrants";
}

/**
 * The tier a canvas should actually use.
 *
 * Precedence, and each level exists for a different reason:
 *
 * 1. `CANVAS_GRAPHICS` — the user's override. First because a wrong guess
 *    must never be a dead end, and because it is the one lever someone has
 *    when their terminal is misclassified in either direction.
 * 2. `passed` — what the controller detected and handed down. A canvas in a
 *    tmux pane cannot see the outer terminal, so this is the only real
 *    information it has.
 * 3. A look at the process tree, when inside tmux and a probe was supplied.
 *    The environment cannot be trusted there, and asking the terminal
 *    directly can hang; the operating system knows the answer already.
 * 4. Environment detection — correct when the canvas is NOT in a pane, which
 *    is `show` run directly, and the fallback whenever the probe finds
 *    nothing it recognises.
 */
export function resolveGraphics(
  env: NodeJS.ProcessEnv,
  passed?: string,
  /**
   * How to look up the terminal on the other side of tmux. Optional so the
   * pure-environment behaviour stays available and testable; production
   * passes `systemProbe`.
   */
  source?: ProbeSource
): GraphicsTier {
  const override = env.CANVAS_GRAPHICS;
  if (override !== undefined && override.length > 0) {
    if (isGraphicsTier(override)) return override;
    // A typo'd override is reported by the caller rather than silently
    // ignored: someone who set it meant something by it.
    throw new Error(
      `Invalid CANVAS_GRAPHICS: ${JSON.stringify(override)}. ` +
        `Expected one of: ${GRAPHICS_TIERS.join(", ")}.`
    );
  }
  if (passed !== undefined && passed.length > 0) {
    if (isGraphicsTier(passed)) return passed;
    throw new Error(
      `Invalid --graphics: ${JSON.stringify(passed)}. ` +
        `Expected one of: ${GRAPHICS_TIERS.join(", ")}.`
    );
  }
  // 3. Inside tmux, look at the process tree instead of believing the
  //    environment. A tmux server keeps the environment of whichever client
  //    started it and never refreshes TERM_PROGRAM, so a server started from
  //    Apple Terminal and attached from WezTerm reports Apple Terminal --
  //    measured, with the Sixel-capable terminal on screen. The probe finds
  //    the emulator above the client's tty; when it cannot, it returns null
  //    and this falls through unchanged.
  if (source !== undefined && env.TMUX !== undefined && env.TMUX.length > 0) {
    const probed = outerTerminalEnv(source, env);
    if (probed !== null) return detectGraphics(probed);
  }
  return detectGraphics(env);
}
