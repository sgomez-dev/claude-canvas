// Scenario Registry - Central lookup for all scenarios

import type { ScenarioDefinition } from "./types";
import { displayScenario } from "./calendar/display";
import { meetingPickerScenario } from "./calendar/meeting-picker";
import { documentDisplayScenario } from "./document/display";
import { documentEditScenario } from "./document/edit";
import { emailPreviewScenario } from "./document/email-preview";
import { flightBookingScenario } from "./flight/booking";
import { diffReviewScenario } from "./diff/review";
import { pickerSelectScenario } from "./picker/select";
import { formFillScenario } from "./form/fill";
import { tableDisplayScenario } from "./table/display";
import { dashboardDisplayScenario } from "./dashboard/display";
import { imageDisplayScenario } from "./image/display";

// Registry of all scenarios keyed by "canvasKind:scenarioName"
const registry = new Map<string, ScenarioDefinition>();

// Register calendar scenarios
registry.set("calendar:display", displayScenario);
registry.set("calendar:meeting-picker", meetingPickerScenario);

// Register document scenarios
registry.set("document:display", documentDisplayScenario);
registry.set("document:edit", documentEditScenario);
registry.set("document:email-preview", emailPreviewScenario);

// Register flight scenarios
registry.set("flight:booking", flightBookingScenario);

// Register diff scenarios
registry.set("diff:review", diffReviewScenario);

// Register picker scenarios
registry.set("picker:select", pickerSelectScenario);

// Register form scenarios
registry.set("form:fill", formFillScenario);

// Register table scenarios
registry.set("table:display", tableDisplayScenario);

// Register dashboard scenarios
registry.set("dashboard:display", dashboardDisplayScenario);

// Register image scenarios
registry.set("image:display", imageDisplayScenario);

export function getScenario(
  canvasKind: string,
  scenarioName: string
): ScenarioDefinition | undefined {
  return registry.get(`${canvasKind}:${scenarioName}`);
}

/**
 * Every scenario, or every scenario for one kind. Surfaced by the
 * `scenarios` CLI verb -- this had no caller at all for two phases, which
 * is how the registry came to hold entries nothing ever read.
 */
export function listScenarios(canvasKind?: string): ScenarioDefinition[] {
  const scenarios: ScenarioDefinition[] = [];
  for (const [key, scenario] of registry) {
    if (!canvasKind || key.startsWith(`${canvasKind}:`)) {
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

export function registerScenario(scenario: ScenarioDefinition): void {
  registry.set(`${scenario.canvasKind}:${scenario.name}`, scenario);
}
