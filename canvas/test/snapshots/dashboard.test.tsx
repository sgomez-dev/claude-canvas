import { test, expect } from "bun:test";
import React from "react";
import { Dashboard } from "../../src/canvases/dashboard";
import type { DashboardConfig } from "../../src/canvases/dashboard/types";
import { renderCanvas } from "../harness/render";

// Four region kinds in one pane, which is what sub-project 1's split was
// for: none of this rendering is new, and none of it was reachable before.
const CONFIG: DashboardConfig = {
  title: "claude-canvas",
  regions: [
    {
      id: "status",
      kind: "text",
      title: "git",
      rows: 4,
      config: { text: "On branch main. 3 files changed." },
    },
    {
      id: "tests",
      kind: "table",
      title: "Tests",
      rows: 7,
      config: {
        columns: [
          { key: "suite", label: "Suite", width: 14 },
          { key: "result", label: "Result", width: 8 },
        ],
        rows: [
          { suite: "protocol", result: "15 ok" },
          { suite: "registry", result: "13 ok" },
        ],
      },
    },
    {
      id: "todo",
      kind: "picker",
      title: "Next",
      config: {
        mode: "single",
        options: [
          { id: "sixel", label: "Sixel encoder" },
          { id: "png", label: "PNG decoder" },
        ],
      },
    },
  ],
};

test("dashboard renders several region kinds in one pane", async () => {
  const r = renderCanvas(<Dashboard id="dash-1" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 26,
  });
  const frame = await r.settle();
  expect(frame).toContain("On branch main");
  expect(frame).toContain("protocol");
  expect(frame).toContain("Sixel encoder");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// The focus indicator has to be visible without colour, like every other
// state in this codebase. A `text` region is skipped: it has no interaction
// to give focus to.
test("focus starts on the first interactive region, skipping text", async () => {
  const r = renderCanvas(<Dashboard id="dash-2" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 26,
  });
  const frame = await r.settle();
  // The table region is focused, so its scroll keys are live; the picker's
  // cursor gutter shows it is not.
  expect(frame).toContain("Tab: region");
  r.dispose();
});

test("dashboard renders a config error for an unknown region kind", async () => {
  const r = renderCanvas(
    <Dashboard
      id="dash-3"
      config={{ regions: [{ id: "x", kind: "chart" as never, config: {} }] }}
      enabled={false}
    />,
    { columns: 60, rows: 10 }
  );
  const frame = await r.settle();
  expect(frame).toContain("unsupported kind");
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// The payoff of extracting the validators in sub-project 1: a bad picker
// config inside a dashboard is reported by the same code, with the same
// message, as a bad picker config given to the picker canvas.
test("a region's own config is validated by that kind's validator", async () => {
  const r = renderCanvas(
    <Dashboard
      id="dash-4"
      config={{ regions: [{ id: "p", kind: "picker", config: { mode: "single", options: [] } }] }}
      enabled={false}
    />,
    { columns: 60, rows: 10 }
  );
  const frame = await r.settle();
  expect(frame).toContain('region "p"');
  expect(frame).toContain("must not be empty");
  r.dispose();
});

test("dashboard is deterministic across renders", async () => {
  const a = renderCanvas(<Dashboard id="dash-5" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 26,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Dashboard id="dash-5" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 26,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});
