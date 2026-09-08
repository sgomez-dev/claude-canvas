import type { ScenarioDefinition } from "../types";

export const meetingPickerScenario: ScenarioDefinition = {
  name: "meeting-picker",
  description: "Select a free time slot when viewing multiple calendars",
  canvasKind: "calendar",
  interactionMode: "selection",
};
