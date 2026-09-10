import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { toQuadrants, DEFAULT_QUADRANT_BACKGROUND } from "./quadrants";
import type { RGB } from "./graphics/resample";
import type { DecodedImage } from "./png";

export interface QuadrantImageProps {
  image: DecodedImage;
  columns: number;
  rows: number;
  /** What transparent pixels resolve to. A terminal cannot report its own. */
  background?: RGB;
}

/**
 * Paints an image with quadrant cells, four pixels per cell.
 *
 * One `<Text>` per colour-and-glyph run, exactly as the half-block view
 * does. Runs are shorter here -- a cell has to match on glyph as well as on
 * both colours -- which is the cost of the extra resolution and still far
 * cheaper than one element per cell.
 */
export function QuadrantImage({
  image,
  columns,
  rows,
  background = DEFAULT_QUADRANT_BACKGROUND,
}: QuadrantImageProps): React.JSX.Element {
  const grid = useMemo(
    () => toQuadrants(image, columns, rows, background),
    [image, columns, rows, background]
  );
  return (
    <Box flexDirection="column">
      {grid.map((runs, y) => (
        <Box key={y}>
          {runs.map((run, i) => (
            <Text key={i} color={run.fg} backgroundColor={run.bg}>
              {run.glyph.repeat(run.count)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
