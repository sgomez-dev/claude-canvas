import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { toHalfBlocks, HALF_BLOCK, DEFAULT_BACKGROUND, type RGB } from "./halfblocks";
import type { DecodedImage } from "./png";

export interface HalfBlockImageProps {
  image: DecodedImage;
  columns: number;
  rows: number;
  /** What transparent pixels resolve to. A terminal cannot report its own. */
  background?: RGB;
}

/**
 * Paints an image with `▀` cells, two pixels per cell.
 *
 * One `<Text>` per colour run rather than per cell: a solid 80x24 pane would
 * otherwise be 1920 elements for Ink to measure and lay out, and runs
 * collapse it to 24.
 *
 * This is the tier that works everywhere, and the only one made of ordinary
 * styled text -- which is why it is the one the snapshot harness can verify
 * byte for byte.
 */
export function HalfBlockImage({
  image,
  columns,
  rows,
  background = DEFAULT_BACKGROUND,
}: HalfBlockImageProps): React.JSX.Element {
  const grid = useMemo(
    () => toHalfBlocks(image, columns, rows, background),
    [image, columns, rows, background]
  );
  return (
    <Box flexDirection="column">
      {grid.map((runs, y) => (
        <Box key={y}>
          {runs.map((run, i) => (
            <Text key={i} color={run.fg} backgroundColor={run.bg}>
              {HALF_BLOCK.repeat(run.count)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
