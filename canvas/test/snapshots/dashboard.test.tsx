import { test, expect } from "bun:test";
import React from "react";
import { Dashboard } from "../../src/canvases/dashboard";
import { PickerView } from "../../src/canvases/picker/view";
import { TableView } from "../../src/canvases/table/view";
import { FormView } from "../../src/canvases/form/view";
import { DiffView } from "../../src/canvases/diff/view";
import { validatePicker } from "../../src/canvases/picker/validate";
import { validateTable } from "../../src/canvases/table/validate";
import { validateForm } from "../../src/canvases/form/validate";
import { parseDiffConfig } from "../../src/canvases/diff/validate";
import type { DashboardConfig } from "../../src/canvases/dashboard/types";
import { renderCanvas } from "../harness/render";

function stripAnsi(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*m/g, "");
}

// Counts every row the frame actually occupies, INCLUDING blank ones (e.g.
// the marginTop gap Ink renders between a region and the dashboard's own
// footer, or between diff's file-list and hunk boxes) -- each is a real,
// empty terminal row, not a formatting artifact to discard. Filtering
// those out (as some other rendering tests in this file's style do, for a
// single view's own content with no such gaps) would undercount a frame's
// true height and could let a real overflow of exactly the blank-row kind
// pass silently.
function lineCount(frame: string): number {
  return stripAnsi(frame).split("\n").length;
}

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
  const frame = (await r.settle()).replace(/\x1b\[[0-9;]*m/g, "");
  expect(frame).toContain("Home/End: region");
  // The table region (the first focusable one -- `text` is skipped) is
  // focused; the picker's cursor gutter must NOT show a live-looking
  // cursor on an option it doesn't actually own yet. This used to pass
  // even when every view ignored `focused` entirely and showed its cursor
  // regardless -- asserted here with colour stripped, since that gutter is
  // exactly the state this codebase requires to survive NO_COLOR.
  expect(frame).not.toContain("> Sixel encoder");
  expect(frame).toContain("  Sixel encoder");
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

// Regression tests for Fix 1: dashboard.tsx's `renderRegion` only ever
// wired the real terminal `columns` through to the `tree` region kind --
// `picker`, `table`, `form` and `diff` each have their own identical
// footer-wrap budget (see their `innerWidth`/wrap-reservation comments),
// but were left falling back to their `columns`/`terminalWidth` prop's
// default of 80 regardless of the real pane width. Rendered through the
// REAL `Dashboard` (not an isolated view with an explicitly-passed width,
// which is exactly what let the gap through the first time), at a
// realistic narrow split pane this understated each affected region's own
// footer height by a row, so the region rendered taller than
// dashboard.tsx's own `allocateRows` had budgeted it -- pushing the
// dashboard's own "Home/End: region  Esc: close" hint (the only on-screen
// way to switch focus or close the pane) past the bottom of the terminal.

// Short, single-character paths: diff's file-list row and hunk header each
// reserve a FIXED, unwrapped row (a separate, pre-existing limitation of
// diff/view.tsx -- it has no wrap-budget reservation for either of those,
// only for its footer hint) -- a longer path or a hunk large enough to need
// clipping can wrap one of those on its own at a narrow width, regardless
// of Fix 1's footer-columns wiring. Kept short and unclipped throughout so
// these tests isolate the footer regression instead of that unrelated gap.
const SAMPLE_DIFF_TEXT = `diff --git a/a b/a
index 1111111..2222222 100644
--- a/a
+++ b/a
@@ -1,2 +1,2 @@
-old a
+new a
 shared
diff --git a/b b/b
index 3333333..4444444 100644
--- a/b
+++ b/b
@@ -1,1 +1,1 @@
-old b
+new b
`;

const TABLE_PICKER_CONFIG: DashboardConfig = {
  title: "ops",
  regions: [
    {
      id: "tests",
      kind: "table",
      title: "Tests",
      config: {
        columns: [
          { key: "suite", label: "Suite", width: 14 },
          { key: "result", label: "Result", width: 8 },
        ],
        rows: Array.from({ length: 40 }, (_, i) => ({ suite: `suite-${i + 1}`, result: "ok" })),
      },
    },
    {
      id: "todo",
      kind: "picker",
      title: "Next",
      config: {
        mode: "single",
        options: Array.from({ length: 20 }, (_, i) => ({ id: `o${i + 1}`, label: `Option ${i + 1}` })),
      },
    },
  ],
};

const FORM_DIFF_CONFIG: DashboardConfig = {
  title: "review",
  regions: [
    {
      id: "bug",
      kind: "form",
      title: "Report",
      // Diff's own CHROME_ROWS (its two nested boxes' borders/titles/margin
      // plus its footer row) is 10, so an even split of a modest terminal
      // would floor the diff region's file/hunk rows at its own minimum of
      // 2 regardless of how much extra the wrapped footer needs -- an
      // unrelated, pre-existing budget-floor behavior, not what Fix 1 is
      // about. Explicit, generous `rows` on both regions here keeps this
      // test isolated to the actual regression (columns not wired through).
      rows: 11,
      config: {
        fields: [
          { id: "summary", type: "text", label: "Summary", required: true },
          { id: "details", type: "textarea", label: "Details", placeholder: "What happened?" },
        ],
      },
    },
    {
      id: "diff",
      kind: "diff",
      title: "Changes",
      // A larger budget than the multi-region floor test elsewhere needs:
      // this keeps hunk/file content unclipped (see SAMPLE_DIFF_TEXT's
      // comment) at every tested width, including once Fix 1 reserves the
      // real footer-wrap rows, so no clipping-triggered suffix text is ever
      // on screen to wrap on its own.
      rows: 18,
      config: { diffText: SAMPLE_DIFF_TEXT },
    },
  ],
};

for (const [name, config, rows] of [
  ["table + picker", TABLE_PICKER_CONFIG, 24],
  ["form + diff", FORM_DIFF_CONFIG, 32],
] as const) {
  test(`${name}: dashboard's own footer stays on screen at narrow widths`, async () => {
    for (const columns of [50, 40, 30]) {
      const r = renderCanvas(
        <Dashboard id={`dash-${name}-${columns}`} config={config} enabled={false} />,
        { columns, rows }
      );
      const frame = await r.settle();
      const plain = stripAnsi(frame);

      // The dashboard's own footer/key-hint text must always be part of
      // the rendered frame within the terminal's own row budget -- not
      // merely present somewhere in a taller-than-the-terminal frame.
      expect(lineCount(frame)).toBeLessThanOrEqual(rows);
      expect(plain).toContain("Esc: close");

      r.dispose();
    }
  });
}

// Per-view: each of the four affected region kinds, mounted alone through
// the real Dashboard, renders BYTE-IDENTICAL region content to that same
// view rendered standalone at the same real width with an equivalent
// budget -- proof dashboard.tsx actually forwards the real `columns`/
// `terminalWidth`, not an inference from total row counts. Total-height
// heuristics (as tried initially here) get entangled with diff/table's OTHER
// pre-existing, unrelated wrap gaps (e.g. diff's hunk header and file-list
// row have no wrap-budget reservation of their own, only the footer does)
// once content needs to clip -- an exact-match comparison sidesteps all of
// that: whatever a view renders on its own at a given width is exactly what
// it must render embedded in the dashboard at that same width, confounds or
// not.
//
// Dashboard's own chrome for a single-region config is always exactly 3
// rows -- the title (1), the marginTop blank line before the footer (1),
// and the footer text itself (1), since `focusable.length` is 1 here so the
// "Home/End: region  " prefix never appears -- so the region's own content
// is exactly `lines.slice(1, -2)` of the dashboard's frame.
function extractSingleRegionContent(frame: string): string {
  const lines = stripAnsi(frame).split("\n");
  return lines.slice(1, -2).join("\n");
}

const NARROW_WIDTHS = [50, 40, 30];

test("picker region: dashboard forwards the real columns, matching standalone rendering", async () => {
  const { options, mode } = validatePicker({
    mode: "single",
    options: Array.from({ length: 20 }, (_, i) => ({ id: `o${i + 1}`, label: `Option ${i + 1}` })),
  } as never);
  const dashboardConfig: DashboardConfig = {
    regions: [{ id: "r", kind: "picker", config: { mode, options } as never }],
  };
  const rows = 24;
  const budget = rows - 3; // dashboard's own CHROME_ROWS for a single region

  for (const columns of NARROW_WIDTHS) {
    const embedded = renderCanvas(
      <Dashboard id={`picker-embed-${columns}`} config={dashboardConfig} enabled={false} />,
      { columns, rows }
    );
    const standalone = renderCanvas(
      <PickerView options={options} mode={mode} rows={budget} columns={columns} focused onSubmit={() => {}} />,
      { columns, rows }
    );
    const embeddedFrame = await embedded.settle();
    const standaloneFrame = await standalone.settle();
    expect(extractSingleRegionContent(embeddedFrame)).toBe(stripAnsi(standaloneFrame));
    embedded.dispose();
    standalone.dispose();
  }
});

test("table region: dashboard forwards the real terminalWidth, matching standalone rendering", async () => {
  const { columns: tableColumns, rows: dataRows } = validateTable({
    columns: [
      { key: "suite", label: "Suite", width: 14 },
      { key: "result", label: "Result", width: 8 },
    ],
    rows: Array.from({ length: 40 }, (_, i) => ({ suite: `suite-${i + 1}`, result: "ok" })),
  } as never);
  const dashboardConfig: DashboardConfig = {
    regions: [
      { id: "r", kind: "table", config: { columns: tableColumns, rows: dataRows } as never },
    ],
  };
  const rows = 24;
  const budget = rows - 3;

  for (const columns of NARROW_WIDTHS) {
    const embedded = renderCanvas(
      <Dashboard id={`table-embed-${columns}`} config={dashboardConfig} enabled={false} />,
      { columns, rows }
    );
    const standalone = renderCanvas(
      <TableView columns={tableColumns} rows={dataRows} budget={budget} terminalWidth={columns} focused />,
      { columns, rows }
    );
    const embeddedFrame = await embedded.settle();
    const standaloneFrame = await standalone.settle();
    expect(extractSingleRegionContent(embeddedFrame)).toBe(stripAnsi(standaloneFrame));
    embedded.dispose();
    standalone.dispose();
  }
});

test("form region: dashboard forwards the real columns, matching standalone rendering", async () => {
  const { fields } = validateForm({
    fields: [
      { id: "summary", type: "text", label: "Summary", required: true },
      { id: "details", type: "textarea", label: "Details", placeholder: "What happened?" },
    ],
  } as never);
  const dashboardConfig: DashboardConfig = {
    regions: [{ id: "r", kind: "form", config: { fields } as never }],
  };
  // Tight enough that whether the footer's wrap is correctly reserved for
  // actually changes how many fields are shown -- a generous budget lets
  // both fields render regardless (nothing to clip), which would make the
  // embedded and standalone renders match even with the bug still present.
  const rows = 14;
  const budget = rows - 3;

  for (const columns of NARROW_WIDTHS) {
    const embedded = renderCanvas(
      <Dashboard id={`form-embed-${columns}`} config={dashboardConfig} enabled={false} />,
      { columns, rows }
    );
    const standalone = renderCanvas(
      <FormView fields={fields} budget={budget} columns={columns} focused onSubmit={() => {}} />,
      { columns, rows }
    );
    const embeddedFrame = await embedded.settle();
    const standaloneFrame = await standalone.settle();
    expect(extractSingleRegionContent(embeddedFrame)).toBe(stripAnsi(standaloneFrame));
    embedded.dispose();
    standalone.dispose();
  }
});

test("diff region: dashboard forwards the real columns, matching standalone rendering", async () => {
  const { files } = parseDiffConfig({ diffText: SAMPLE_DIFF_TEXT } as never);
  const dashboardConfig: DashboardConfig = {
    regions: [{ id: "r", kind: "diff", config: { diffText: SAMPLE_DIFF_TEXT } as never }],
  };
  // Tight enough that whether the footer's wrap is correctly reserved for
  // actually changes how many hunk lines are shown -- see the form test's
  // comment above for why a generous budget wouldn't catch the bug.
  const rows = 19;
  const budget = rows - 3;

  for (const columns of NARROW_WIDTHS) {
    const embedded = renderCanvas(
      <Dashboard id={`diff-embed-${columns}`} config={dashboardConfig} enabled={false} />,
      { columns, rows }
    );
    const standalone = renderCanvas(
      <DiffView files={files} budget={budget} columns={columns} focused onSubmit={() => {}} />,
      { columns, rows }
    );
    const embeddedFrame = await embedded.settle();
    const standaloneFrame = await standalone.settle();
    expect(extractSingleRegionContent(embeddedFrame)).toBe(stripAnsi(standaloneFrame));
    embedded.dispose();
    standalone.dispose();
  }
});
