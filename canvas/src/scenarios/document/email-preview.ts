import type { ScenarioDefinition } from "../types";

export const emailPreviewScenario: ScenarioDefinition = {
  name: "email-preview",
  description: "Email draft preview with headers and selectable body",
  canvasKind: "document",
  interactionMode: "selection",
};
