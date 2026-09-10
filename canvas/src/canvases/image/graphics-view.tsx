import React, { useEffect } from "react";
import { Box, Text, useStdout } from "ink";
import { fitToCells } from "../halfblocks";
import { paintBytes } from "../graphics/paint";
import { wrappedLineCount } from "../width";
import type { GraphicsTier } from "../../host/graphics";
import type { RGB } from "../graphics/resample";
import type { DecodedImage } from "../png";
import { FOOTER_HINT } from "./types";

export interface GraphicsImageViewProps {
  image: DecodedImage;
  /** The original PNG bytes: kitty and iTerm2 decode these themselves. */
  png: Uint8Array;
  tier: GraphicsTier;
  title?: string;
  background: RGB;
  budget: number;
  terminalWidth: number;
  cell: { width: number; height: number };
  /**
   * This canvas instance's own kitty image id (see `imageIdFor` in
   * `graphics/kitty.ts`). Only kitty's placement/delete pair is scoped by
   * it, but it is required regardless of tier so switching tiers is never
   * the thing that silently drops the scoping.
   */
  imageId: number;
}

/**
 * Reserves rows for an image and paints it with a terminal protocol.
 *
 * **Deliberately borderless**, unlike the half-block view. A protocol image
 * is placed at an absolute cursor position, so the origin has to be
 * computed rather than laid out -- and a border plus padding would make that
 * origin a pair of constants that silently go stale the moment the chrome
 * changes. Without them the origin is exactly "under the title, at column
 * one", which is derivable from the same prop that decides whether a title
 * renders at all.
 *
 * The repaint has **no dependency array on purpose**. Ink redraws its whole
 * frame on every commit, and for iTerm2 and Sixel that redraw erases an
 * image drawn into the text grid, so the image has to be re-emitted after
 * each one. Painting only on a change would leave a blank gap after any
 * unrelated re-render.
 */
export function GraphicsImageView({
  image,
  png,
  tier,
  title,
  background,
  budget,
  terminalWidth,
  cell,
  imageId,
}: GraphicsImageViewProps): React.JSX.Element {
  const { stdout } = useStdout();

  // The tier is named in the footer while these protocols are new: when an
  // image renders wrong, which one produced it is the first thing worth
  // knowing, and the alternative is guessing from the terminal's identity.
  const footerText = `${image.width}×${image.height}  ${tier}  ${FOOTER_HINT}`;
  const footerOverflow = Math.max(0, wrappedLineCount(footerText, terminalWidth) - 1);

  const titleRows = title !== undefined ? 1 : 0;
  const availableRows = Math.max(1, budget - titleRows - 1 - footerOverflow);
  const fit = fitToCells(image.width, image.height, terminalWidth, availableRows);

  // 1-based, as the terminal counts: the title occupies row 1 when present,
  // so the image starts on the row after it.
  const originRow = titleRows + 1;

  useEffect(() => {
    const bytes = paintBytes({
      tier,
      png,
      image,
      columns: fit.columns,
      rows: fit.rows,
      originRow,
      originColumn: 1,
      background,
      cell,
      imageId,
      env: process.env,
    });
    if (bytes.length > 0) stdout?.write(bytes);
  });

  return (
    <Box flexDirection="column">
      {title !== undefined && (
        <Text bold color="cyan">
          {title}
        </Text>
      )}
      {/* Blank rows the protocol image is painted over. They exist so Ink
          reserves the space and puts the footer below the image instead of
          on top of it. */}
      {Array.from({ length: fit.rows }, (_, i) => (
        <Text key={i}> </Text>
      ))}
      <Text dimColor>{footerText}</Text>
    </Box>
  );
}
