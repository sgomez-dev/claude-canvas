/**
 * iTerm2's inline images protocol.
 *
 * `<ESC>]1337;File=<args>:<base64><BEL>` — an OSC sequence. iTerm2 supports
 * Sixel as well, but this is higher fidelity and needs no palette
 * quantisation, which is why `iterm2` is its own tier rather than folded
 * into `sixel`.
 */

export interface ITerm2Placement {
  columns: number;
  rows: number;
}

/**
 * Encodes a PNG for display in a `columns` x `rows` cell box.
 *
 * `width` and `height` are bare numbers, which iTerm2 reads as **cells**
 * (the same argument means pixels when suffixed `px` and a fraction of the
 * pane when suffixed `%`). Cells are what the caller already computed, and
 * the terminal resamples the full-resolution file into them.
 *
 * `preserveAspectRatio=1` is iTerm2's default and is stated anyway: the cell
 * box comes from `fitToCells`, which has already matched the aspect ratio,
 * so if the two ever disagree the image should letterbox rather than
 * stretch.
 *
 * Returned as a single-element array to match the other encoders, so tmux
 * passthrough wrapping is applied the same way for every tier.
 */
export function encodeITerm2(png: Uint8Array, placement: ITerm2Placement): string[] {
  const payload = Buffer.from(png).toString("base64");
  const args = [
    "inline=1",
    // Declaring the byte count lets iTerm2 show a progress indicator for a
    // large image instead of appearing to hang. It is the DECODED length,
    // not the base64 length.
    `size=${png.byteLength}`,
    `width=${placement.columns}`,
    `height=${placement.rows}`,
    "preserveAspectRatio=1",
  ].join(";");
  return [`\x1b]1337;File=${args}:${payload}\x07`];
}
