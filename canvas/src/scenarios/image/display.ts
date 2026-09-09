import type { ScenarioDefinition } from "../types";

export const imageDisplayScenario: ScenarioDefinition = {
  name: "display",
  description: "Show a PNG scaled to fit the pane, using half-block cells",
  canvasKind: "image",
  interactionMode: "view-only",
};
