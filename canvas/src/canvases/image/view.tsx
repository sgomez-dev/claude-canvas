import React from "react";
import { Box, Text } from "ink";
import { HalfBlockImage } from "../halfblock-view";
import { fitToCells, type RGB } from "../halfblocks";
import { wrappedLineCount } from "../width";
import type { DecodedImage } from "../png";

export interface ImageViewProps {
  image: DecodedImage;
  title?: string;
  background: RGB;
  /** Rows this view may paint into: the terminal height, or a region's share. */
  budget: number;
  terminalWidth: number;
}

// One column of border on each side plus one of paddingX on each side.
const HORIZONTAL_CHROME = 4;
// Rows the frame spends whatever the image is: top border, bottom border,
// and the footer line. A title, when present, costs one more.
const BASE_CHROME_ROWS = 3;
const FOOTER_HINT = "Esc: close";

/**
 * Renders a decoded image scaled to fit the rows it was given.
 *
 * Deliberately takes no `focused` prop, unlike every other view here. Those
 * gate their keys on it; this one has no keys to gate -- the image fits the
 * pane, so there is nothing to scroll or move -- and a prop accepted and
 * ignored reads as a contract to whoever finds it next.
 */
export function ImageView({
  image,
  title,
  background,
  budget,
  terminalWidth,
}: ImageViewProps): React.JSX.Element {
  const innerWidth = Math.max(1, terminalWidth - HORIZONTAL_CHROME);

  // The dimensions go in the footer next to the hint, and the string that is
  // MEASURED is the string that is RENDERED. Five views here once kept those
  // as separate literals, so editing the visible hint silently mismeasured
  // how many rows it would occupy; one binding makes that drift impossible.
  const footerText = `${image.width}×${image.height}  ${FOOTER_HINT}`;
  const footerOverflow = Math.max(0, wrappedLineCount(footerText, innerWidth) - 1);

  const chrome = BASE_CHROME_ROWS + (title !== undefined ? 1 : 0) + footerOverflow;
  const availableRows = Math.max(1, budget - chrome);
  const fit = fitToCells(image.width, image.height, innerWidth, availableRows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {title !== undefined && (
        <Text bold color="cyan">
          {title}
        </Text>
      )}
      <HalfBlockImage
        image={image}
        columns={fit.columns}
        rows={fit.rows}
        background={background}
      />
      <Text dimColor>{footerText}</Text>
    </Box>
  );
}
