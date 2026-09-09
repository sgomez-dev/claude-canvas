import { test, expect } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import { renderCanvas } from "../harness/render";

const SINGLE_CONFIG = {
  title: "Pick one",
  mode: "single" as const,
  options: [
    { id: "a", label: "Option A", description: "the first one" },
    { id: "b", label: "Option B" },
    { id: "c", label: "Option C (unavailable)", disabled: true },
  ],
};

const MULTI_CONFIG = {
  title: "Pick any",
  mode: "multi" as const,
  options: [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
    { id: "z", label: "Z (unavailable)", disabled: true },
  ],
};

test("picker renders single-select mode", async () => {
  const r = renderCanvas(<Picker id="picker-1" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker renders multi-select mode", async () => {
  const r = renderCanvas(<Picker id="picker-2" config={MULTI_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker renders an empty-options error state", async () => {
  const r = renderCanvas(
    <Picker id="picker-3" config={{ mode: "single", options: [] }} enabled={false} />,
    { columns: 60, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("picker is deterministic across renders", async () => {
  const a = renderCanvas(<Picker id="picker-4" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(<Picker id="picker-4" config={SINGLE_CONFIG} enabled={false} />, {
    columns: 60,
    rows: 15,
  });
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});

// `mode` is required. It used to be accepted as absent and silently
// defaulted to "single", so a config that meant multi-select but omitted
// the field opened a single-select canvas with nothing reported anywhere.
test("picker renders a config error when mode is missing", async () => {
  const r = renderCanvas(
    // Cast: the point of the test is the runtime guard for a config that
    // does not satisfy PickerConfig, which is exactly what arrives from a
    // JSON --config-file that the type system never saw.
    <Picker
      id="picker-6"
      config={{ options: [{ id: "a", label: "A" }] } as never}
      enabled={false}
    />,
    { columns: 60, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// Regression test for Fix 3's footer-wrap half: at a narrow terminal width
// the multi-select footer hint (56 columns) wraps onto a second line inside
// a narrower box, which the row-budget math's flat "one line of hint text"
// assumption didn't account for. Verified at the exact dimensions the
// independent review reproduced this at.
test("at a narrow terminal width, the frame never exceeds the terminal's row count", async () => {
  const rows = 12;
  const r = renderCanvas(<Picker id="picker-8" config={MULTI_CONFIG} enabled={false} />, {
    columns: 40,
    rows,
  });
  const frame = await r.settle();
  expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
  r.dispose();
});

test("picker windows a list longer than the pane", async () => {
  const r = renderCanvas(
    <Picker
      id="picker-7"
      config={{
        title: "Many",
        mode: "single",
        options: Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
      }}
      enabled={false}
    />,
    { columns: 40, rows: 12 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});
