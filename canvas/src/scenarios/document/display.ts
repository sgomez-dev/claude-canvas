import type { ScenarioDefinition } from "../types";

export const documentDisplayScenario: ScenarioDefinition = {
  name: "display",
  description: "Read-only markdown document view",
  canvasKind: "document",
  interactionMode: "view-only",
};
