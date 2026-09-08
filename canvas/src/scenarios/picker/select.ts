import type { ScenarioDefinition } from "../types";

export const pickerSelectScenario: ScenarioDefinition = {
  name: "select",
  description: "Choose one or more options from a list",
  canvasKind: "picker",
  interactionMode: "selection",
};
