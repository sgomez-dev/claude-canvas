import type { ScenarioDefinition } from "../types";

export const formFillScenario: ScenarioDefinition = {
  name: "fill",
  description: "Fill in a small set of structured fields and submit them as one result",
  canvasKind: "form",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
