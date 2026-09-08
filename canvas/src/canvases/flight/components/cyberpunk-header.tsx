// Cyberpunk Header Component - Neon styled title bar

import React from "react";
import { Box, Text } from "ink";
import { CYBER_COLORS } from "../types";
import { formatTime } from "../../format";

interface Props {
  title: string;
  width: number;
}

export function CyberpunkHeader({ title, width }: Props) {
  // Create border line
  const borderChar = "=";
  const border = borderChar.repeat(width - 2);

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Text color={CYBER_COLORS.neonMagenta}>{border}</Text>

      {/* Title row */}
      <Box justifyContent="space-between" width={width - 2}>
        <Text color={CYBER_COLORS.neonCyan} bold>
          {title}
        </Text>
        <Text color={CYBER_COLORS.dim}>
          {formatTime(new Date())}
        </Text>
      </Box>

      {/* Bottom border */}
      <Text color={CYBER_COLORS.neonMagenta}>{border}</Text>
    </Box>
  );
}
