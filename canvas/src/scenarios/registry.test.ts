import { test, expect } from "bun:test";
import { getScenario } from "./registry";

// Task 13 registers the flight canvas's only scenario. Before this it was
// missing entirely, so getScenario("flight", "booking") returned undefined
// and nothing validated --scenario booking for the flight canvas.
test("flight booking scenario is registered", () => {
  const scenario = getScenario("flight", "booking");
  expect(scenario).toBeDefined();
  expect(scenario?.canvasKind).toBe("flight");
  expect(scenario?.name).toBe("booking");
});

test("diff:review is registered", () => {
  expect(getScenario("diff", "review")).toBeDefined();
});
