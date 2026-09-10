/**
 * The calendar's colour vocabulary.
 *
 * Shared: the demo fixture assigns from INK_COLORS and the grid maps them
 * through TEXT_COLORS, so leaving them in calendar.tsx meant the fixture
 * could not move out without dragging the constants along.
 */

// Notion-like color palette with text colors for contrast
export const INK_COLORS = ["yellow", "green", "blue", "magenta", "red", "cyan"];

// Text colors: dark for light backgrounds, white for dark backgrounds
export const TEXT_COLORS: Record<string, string> = {
  yellow: "black",
  cyan: "black",
  green: "white",
  blue: "white",
  magenta: "white",
  red: "white",
};
