/**
 * The kitty graphics protocol.
 *
 * `<ESC>_G<control data>;<base64 payload><ESC>\` — an APC sequence a terminal
 * that does not know it will swallow silently, which is why it must only be
 * emitted to a terminal that was actually detected as supporting it.
 *
 * Ghostty implements this protocol too and reports itself as `kitty`, so one
 * encoder covers both.
 */

/**
 * Kitty's own limit: the base64 payload of a single escape must not exceed
 * 4096 bytes. Larger images are split, and the split is not optional -- a
 * single oversized escape is dropped, not truncated.
 */
export const MAX_CHUNK_BASE64 = 4096;

export interface KittyPlacement {
  /** Cell columns the image should occupy. */
  columns: number;
  /** Cell rows the image should occupy. */
  rows: number;
}

/**
 * Encodes a PNG for display in a `columns` x `rows` cell box.
 *
 * Sends the **PNG bytes** (`f=100`) rather than decoded pixels (`f=32`).
 * kitty decodes PNG itself, and the difference is not marginal: this
 * repository's 3384x2160 screenshot is a 2 MB file but 29 MB of RGBA, which
 * base64 expands to 39 MB — a payload that would have to be split into ten
 * thousand escapes and pushed through a terminal one 4 KB chunk at a time.
 *
 * Three control keys are load-bearing beyond the obvious ones:
 *
 * - `q=2` suppresses kitty's OK/error reply. Without it the terminal writes
 *   a response back on the tty, which arrives on the canvas's **stdin** and
 *   is handed to Ink's `useInput` as though the user had typed it.
 * - `C=1` leaves the cursor where it was. Without it the cursor advances
 *   past the image and can scroll the pane, which moves everything Ink
 *   believes it has already drawn.
 * - `c`/`r` scale the image into a cell box, so the caller does the fitting
 *   in cells and the terminal does the resampling at full resolution.
 */
export function encodeKitty(png: Uint8Array, placement: KittyPlacement): string[] {
  const payload = Buffer.from(png).toString("base64");
  const chunks: string[] = [];
  for (let at = 0; at < payload.length; at += MAX_CHUNK_BASE64) {
    chunks.push(payload.slice(at, at + MAX_CHUNK_BASE64));
  }
  // An empty payload would otherwise produce no escape at all, which reads
  // downstream as "the terminal does not support this" rather than "there
  // was nothing to send".
  if (chunks.length === 0) chunks.push("");

  const control =
    `a=T,f=100,q=2,C=1,c=${placement.columns},r=${placement.rows}`;

  // Returns the escapes SEPARATELY rather than pre-joined, because tmux
  // passthrough has to wrap each one in its own DCS: a single DCS carrying
  // this repository's screenshot would be 2.7 MB for tmux to buffer whole.
  return chunks
    .map((chunk, i) => {
      const last = i === chunks.length - 1;
      // The spec is specific about this: the FIRST escape carries all the
      // control data, and every later one carries only `m`. Repeating the
      // control keys on a continuation chunk is not merely redundant — it
      // is a different, malformed request.
      const head = i === 0 ? `${control},m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
      return `\x1b_G${head};${chunk}\x1b\\`;
    });
}
