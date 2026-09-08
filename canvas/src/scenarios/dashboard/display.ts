import type { ScenarioDefinition } from "../types";

export const dashboardDisplayScenario: ScenarioDefinition = {
  name: "display",
  description: "Several primitive views composed into one pane",
  canvasKind: "dashboard",
  // A dashboard's regions may or may not be interactive; when one is, the
  // outcome carries which region answered.
  interactionMode: "selection",
};
