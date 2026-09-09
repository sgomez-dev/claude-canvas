import type { ScenarioDefinition } from "../types";

export const pickerSelectScenario: ScenarioDefinition = {
  name: "select",
  description: "Choose one or more options from a list",
  canvasKind: "picker",
  // picker genuinely supports a multi-select mode (config `mode: "multi"`),
  // which "selection" (implying exactly one result) doesn't describe.
  interactionMode: "multi-select",
};
