import type { ScenarioDefinition } from "../types";

export const diffReviewScenario: ScenarioDefinition = {
  name: "review",
  description: "Review a multi-file unified diff hunk by hunk",
  canvasKind: "diff",
  interactionMode: "selection",
  closeOn: "selection",
  defaultConfig: {},
};
