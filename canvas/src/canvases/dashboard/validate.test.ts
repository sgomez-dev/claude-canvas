import { test, expect } from "bun:test";
import { validateDashboard } from "./validate";
import type { DashboardRegion } from "./types";

// `validateDashboard` had zero direct tests before this file (per an
// independent review of this fix wave) -- every existing check of it went
// through a full Dashboard render in canvas/test/integration/dashboard.test.tsx,
// which exercises the happy path and a couple of error strings but not the
// validator's own edge cases (duplicate ids, non-array regions, an invalid
// `rows`).

const OK_PICKER: DashboardRegion = {
  id: "p",
  kind: "picker",
  config: { mode: "single", options: [{ id: "a", label: "A" }] },
};

test("accepts a well-formed config with one region", () => {
  const { regions, error } = validateDashboard({ regions: [OK_PICKER] });
  expect(error).toBeNull();
  expect(regions).toHaveLength(1);
});

test("rejects a config whose regions is missing or not an array", () => {
  expect(validateDashboard(undefined).error).toMatch(/'regions' must be an array/);
  expect(validateDashboard({ regions: "nope" } as never).error).toMatch(
    /'regions' must be an array/
  );
});

test("rejects an empty regions array", () => {
  expect(validateDashboard({ regions: [] }).error).toMatch(/must not be empty/);
});

test("rejects a region missing an id", () => {
  const error = validateDashboard({
    regions: [{ kind: "picker", config: {} }] as never,
  }).error;
  expect(error).toMatch(/regions\[0\] is missing 'id'/);
});

test("rejects two regions sharing the same id", () => {
  const error = validateDashboard({
    regions: [
      { id: "dup", kind: "text", config: { text: "a" } },
      { id: "dup", kind: "text", config: { text: "b" } },
    ],
  }).error;
  expect(error).toMatch(/duplicate region id "dup"/);
});

test("rejects an unsupported region kind, naming the region and listing what is supported", () => {
  const error = validateDashboard({
    regions: [{ id: "x", kind: "chart", config: {} }] as never,
  }).error;
  expect(error).toMatch(/region "x" has unsupported kind "chart"/);
  expect(error).toMatch(/table, picker, form, diff, tree, text/);
});

// Below 3 rows a bordered region has no room to draw its own border and one
// row of content, per allocateRows's own MIN_REGION_ROWS floor -- this
// rejects the config before it ever reaches that floor at render time.
test("rejects a rows value below the 3-row minimum, and a non-integer rows", () => {
  expect(
    validateDashboard({ regions: [{ id: "x", kind: "text", rows: 2, config: { text: "a" } }] })
      .error
  ).toMatch(/invalid 'rows'/);
  expect(
    validateDashboard({ regions: [{ id: "x", kind: "text", rows: 3.5, config: { text: "a" } }] })
      .error
  ).toMatch(/invalid 'rows'/);
});

test("accepts a rows value of exactly 3, the minimum", () => {
  const { error } = validateDashboard({
    regions: [{ id: "x", kind: "text", rows: 3, config: { text: "a" } }],
  });
  expect(error).toBeNull();
});

// The payoff of extracting the validators in sub-project 1: a region's own
// config is checked by that region kind's own validator, with the error
// prefixed by which region it came from.
test("delegates each region's config to that kind's own validator, prefixed with the region id", () => {
  const error = validateDashboard({
    regions: [{ id: "p", kind: "picker", config: { mode: "single", options: [] } }],
  }).error;
  expect(error).toMatch(/region "p"/);
  expect(error).toMatch(/must not be empty/);
});

test("rejects a text region whose config.text is not a string", () => {
  const error = validateDashboard({
    regions: [{ id: "t", kind: "text", config: { text: 5 } }] as never,
  }).error;
  expect(error).toMatch(/region "t"/);
  expect(error).toMatch(/'text' must be a string/);
});

// Harder variant than the single-bad-region cases above: the FIRST region is
// well-formed and the SECOND is what actually fails, checked so the
// validator's early-return doesn't just always report index 0.
test("reports the actual failing region when it isn't the first one", () => {
  const error = validateDashboard({
    regions: [
      OK_PICKER,
      { id: "bad", kind: "tree", config: { nodes: [] } },
    ],
  }).error;
  expect(error).toMatch(/region "bad"/);
  expect(error).toMatch(/must not be empty/);
});
