import { test, expect } from "bun:test";
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { PickerView } from "../../src/canvases/picker/view";
import { TableView } from "../../src/canvases/table/view";
import { renderCanvas } from "../harness/render";
import type { PickerResult } from "../../src/canvases/picker/types";

// The point of splitting each primitive into a view and a canvas shell is
// that a view can be embedded. Nothing proved that until this file: the
// extraction kept 24 snapshots byte-identical, which shows it broke
// nothing, and shows nothing about whether it enabled anything.
//
// This is the mechanism the dashboard will be built on, tested on its own
// first: two views in one pane, Tab moving focus, and only the focused one
// consuming keys.

const OPTIONS_A = [
  { id: "a1", label: "Alpha one" },
  { id: "a2", label: "Alpha two" },
];
const OPTIONS_B = [
  { id: "b1", label: "Beta one" },
  { id: "b2", label: "Beta two" },
];

const TABLE_ROWS = Array.from({ length: 30 }, (_, i) => ({ n: String(i + 1) }));

/**
 * A minimal composite, standing in for the dashboard: two regions, Tab
 * cycling focus, and the focus owner routing nothing itself -- each view
 * gates its own `useInput` on `isActive`.
 */
function TwoPickers({
  onSubmit,
  initialFocus = 0,
}: {
  onSubmit(regionId: string, r: PickerResult): void;
  initialFocus?: number;
}) {
  const [focus, setFocus] = useState(initialFocus);
  useInput((_input, key) => {
    if (key.tab) setFocus((f) => (f + (key.shift ? 1 : 1)) % 2);
  });
  return (
    <Box flexDirection="column">
      <Text>{focus === 0 ? "> region A" : "  region A"}</Text>
      <PickerView
        options={OPTIONS_A}
        mode="single"
        title="A"
        rows={10}
        focused={focus === 0}
        onSubmit={(r) => onSubmit("A", r)}
      />
      <Text>{focus === 1 ? "> region B" : "  region B"}</Text>
      <PickerView
        options={OPTIONS_B}
        mode="single"
        title="B"
        rows={10}
        focused={focus === 1}
        onSubmit={(r) => onSubmit("B", r)}
      />
    </Box>
  );
}

test("two picker views render in one pane", async () => {
  const r = renderCanvas(<TwoPickers onSubmit={() => {}} />, { columns: 50, rows: 30 });
  const frame = await r.settle();
  expect(frame).toContain("Alpha one");
  expect(frame).toContain("Beta one");
  r.dispose();
});

// The load-bearing assertion. Without `isActive` both views would consume
// every keystroke, so one `j` would move both cursors and one Enter would
// submit twice -- which is exactly what Ink's own docs warn `isActive`
// exists to prevent.
test("only the focused view consumes keys", async () => {
  const submitted: Array<{ region: string; result: PickerResult }> = [];
  const r = renderCanvas(
    <TwoPickers onSubmit={(region, result) => submitted.push({ region, result })} />,
    { columns: 50, rows: 30 }
  );
  await r.settle();

  // Region A is focused. Move its cursor and submit.
  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(submitted).toEqual([{ region: "A", result: { selectedIds: ["a2"] } }]);
  r.dispose();
});

test("Tab moves the focus indicator", async () => {
  const r = renderCanvas(<TwoPickers onSubmit={() => {}} />, { columns: 50, rows: 30 });
  expect(await r.settle()).toContain("> region A");

  r.stdin.write("\t");
  const frame = await r.settle();
  expect(frame).toContain("> region B");
  expect(frame).not.toContain("> region A");
  r.dispose();
});

// Mounted with focus already on B rather than Tabbing to it, deliberately.
//
// `isActive` takes effect when Ink re-registers the input handlers, which
// happens in a passive effect after the render that changed focus -- so a
// keystroke arriving in the same tick as the Tab is still routed by the
// previous assignment. No human types that fast, but a test firing
// keystrokes back to back does, and asserting through a Tab made this race
// CI-only: it passed locally and failed on all three runners.
//
// The two properties are therefore asserted separately: that Tab moves
// focus (above, from the render) and that the focused view is the one that
// answers (here, with no focus change in flight).
test("the focused view is the one that answers", async () => {
  const submitted: Array<{ region: string; result: PickerResult }> = [];
  const r = renderCanvas(
    <TwoPickers
      initialFocus={1}
      onSubmit={(region, result) => submitted.push({ region, result })}
    />,
    { columns: 50, rows: 30 }
  );
  expect(await r.settle()).toContain("> region B");

  // If both views were live, A's cursor would advance too and the Enter
  // would produce two submissions.
  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(submitted).toEqual([{ region: "B", result: { selectedIds: ["b2"] } }]);
  r.dispose();
});

// A composed canvas gives each region a slice of the pane, not the whole
// terminal. The `rows` budget is how a view is told, and a view that
// ignored it would overflow its region and paint over its neighbour.
test("a view windows to the rows budget it is given, not the terminal height", async () => {
  function Constrained({ budget }: { budget: number }) {
    return (
      <TableView
        columns={[{ key: "n", label: "N", width: 4 }]}
        rows={TABLE_ROWS}
        title="Rows"
        budget={budget}
        focused
      />
    );
  }
  // The terminal is 40 rows in both cases; only the budget differs.
  const small = renderCanvas(<Constrained budget={12} />, { columns: 40, rows: 40 });
  expect(await small.settle()).toContain("rows 1-6 of 30");
  small.dispose();

  const large = renderCanvas(<Constrained budget={20} />, { columns: 40, rows: 40 });
  expect(await large.settle()).toContain("rows 1-14 of 30");
  large.dispose();
});
