import type { GraphicsTier } from "../../host/graphics";
import type { DecodedImage } from "../png";
import { encodeKitty } from "./kitty";
import { encodeITerm2 } from "./iterm2";
import { encodeSixel, CELL_PIXELS } from "./sixel";
import { forTerminal } from "./passthrough";
import { DEFAULT_BACKGROUND, type RGB } from "./resample";

export interface PaintRequest {
  tier: GraphicsTier;
  /** The original PNG bytes. kitty and iTerm2 decode these themselves. */
  png: Uint8Array;
  /** The decoded image. Sixel has to resample, so it needs pixels. */
  image: DecodedImage;
  /** Cell box the image should occupy. */
  columns: number;
  rows: number;
  /** Where the image's top-left cell is, 1-based, as the terminal counts. */
  originRow: number;
  originColumn: number;
  background?: RGB;
  cell?: { width: number; height: number };
  env: NodeJS.ProcessEnv;
}

/** Deletes every kitty placement, so a repaint replaces rather than stacks. */
const KITTY_CLEAR = "\x1b_Ga=d,d=A,q=2\x1b\\";

/**
 * The bytes that paint an image at a position, or `""` for a tier that has
 * no protocol.
 *
 * A pure function of the request, so what gets written to a terminal is
 * assertable byte for byte instead of only observable by looking at one.
 *
 * Three layers, and only the middle one is protocol-specific:
 *
 * 1. Save the cursor, position it, restore it afterwards. Ink believes it
 *    knows where the cursor is; leaving it moved corrupts the next frame.
 *    These are ordinary CSI sequences that tmux understands, so they are
 *    **not** passthrough-wrapped -- tmux should act on them.
 * 2. The image escape, which tmux does not understand and therefore must be
 *    wrapped when we are inside a pane.
 * 3. For kitty, a delete first: its placements persist independently of the
 *    text grid, so a second paint would stack on the first instead of
 *    replacing it. iTerm2 and Sixel draw into the grid, which Ink's own
 *    redraw already clears.
 */
export function paintBytes(req: PaintRequest): string {
  const escapes = imageEscapes(req);
  if (escapes.length === 0) return "";

  const clear = req.tier === "kitty" ? forTerminal([KITTY_CLEAR], req.env) : "";
  const position = `\x1b[${req.originRow};${req.originColumn}H`;
  // \x1b7 / \x1b8 rather than CSI s / CSI u: the DEC forms are what every
  // terminal in this project's matrix implements, including Windows
  // Terminal, whose CSI u is the modifyOtherKeys reply instead.
  return `\x1b7${clear}${position}${forTerminal(escapes, req.env)}\x1b8`;
}

function imageEscapes(req: PaintRequest): string[] {
  const placement = { columns: req.columns, rows: req.rows };
  switch (req.tier) {
    case "kitty":
      return encodeKitty(req.png, placement);
    case "iterm2":
      return encodeITerm2(req.png, placement);
    case "sixel":
      return encodeSixel(
        req.image,
        placement,
        req.background ?? DEFAULT_BACKGROUND,
        req.cell ?? CELL_PIXELS
      );
    // Not an omission: these two have no protocol to emit. `halfblocks`
    // paints through Ink as styled text, and `none` means there is no
    // terminal to paint into at all.
    case "halfblocks":
    case "none":
      return [];
  }
}

/** Whether a tier paints by writing escapes rather than through Ink. */
export function usesProtocol(tier: GraphicsTier): boolean {
  return tier === "kitty" || tier === "iterm2" || tier === "sixel";
}
