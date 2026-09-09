/**
 * Getting a terminal escape through tmux to the outer terminal.
 *
 * tmux parses what a pane writes and re-emits its own idea of the screen, so
 * an image protocol escape written inside a pane never reaches the terminal
 * that could render it -- tmux does not understand it and drops it. The way
 * through is a DCS passthrough: tmux unwraps it and forwards the contents
 * verbatim.
 */

/** tmux ≥ 3.3, and the pane must have `allow-passthrough` on. */
export function wrapPassthrough(escape: string): string {
  // Every ESC inside the payload is doubled. tmux collapses each pair back
  // to one on the way out, so a sequence containing an ESC (which every
  // image protocol's terminator does) survives instead of ending the DCS
  // early -- an un-doubled ESC would terminate the passthrough at the first
  // one and spray the rest of the payload onto the screen as text.
  return `\x1bPtmux;${escape.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Whether escapes written from here have to be wrapped.
 *
 * Keyed on `TMUX`, which is present exactly when the process is inside a
 * tmux pane -- unlike `TERM_PROGRAM`, which tmux overwrites with its own
 * name and so cannot distinguish "in tmux" from "in a terminal called
 * tmux".
 */
export function needsPassthrough(env: NodeJS.ProcessEnv): boolean {
  return env.TMUX !== undefined && env.TMUX.length > 0;
}

/** Applies the wrapper to each escape when, and only when, tmux is in the way. */
export function forTerminal(escapes: string[], env: NodeJS.ProcessEnv): string {
  const wrap = needsPassthrough(env);
  return escapes.map((e) => (wrap ? wrapPassthrough(e) : e)).join("");
}
