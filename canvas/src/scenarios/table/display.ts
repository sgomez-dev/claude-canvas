import type { ScenarioDefinition } from "../types";

export const tableDisplayScenario: ScenarioDefinition = {
  name: "display",
  description: "Display tabular data with a fixed header and a scrolling body",
  canvasKind: "table",
  // View-only by design: no result type, no row selection. Row selection
  // composes `table`'s display with `picker`'s selection rather than
  // duplicating selection logic here.
  interactionMode: "view-only",
  closeOn: "escape",
  defaultConfig: {},
};
