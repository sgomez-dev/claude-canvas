import type { ScenarioDefinition } from "../types";

export const flightBookingScenario: ScenarioDefinition = {
  name: "booking",
  description: "Compare flights and select a seat",
  canvasKind: "flight",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
