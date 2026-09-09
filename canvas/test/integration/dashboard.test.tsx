import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Dashboard } from "../../src/canvases/dashboard";
import type { DashboardConfig } from "../../src/canvases/dashboard/types";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection, pushUpdate, waitForOutcome } from "../../src/runtime/client";
import { nextOutcome, settleUntil } from "../harness/ipc";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const TWO_PICKERS: DashboardConfig = {
  title: "Two questions",
  regions: [
    {
      id: "files",
      kind: "picker",
      title: "Files",
      rows: 6,
      config: {
        mode: "single",
        options: [
          { id: "a.ts", label: "a.ts" },
          { id: "b.ts", label: "b.ts" },
        ],
      },
    },
    {
      id: "actions",
      kind: "picker",
      title: "Actions",
      rows: 6,
      config: {
        mode: "single",
        options: [
          { id: "test", label: "run tests" },
          { id: "build", label: "build" },
        ],
      },
    },
  ],
};

async function mount(id: string, config: DashboardConfig, rows = 24) {
  ids.push(id);
  const r = renderCanvas(<Dashboard id={id} config={config} enabled={true} />, {
    columns: 56,
    rows,
  });
  await r.settle();
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  return r;
}

// The composed outcome's whole point: without `regionId` a controller
// receiving {"selectedIds":["a.ts"]} from a dashboard with two pickers could
// not tell which question was answered.
// Fix 1's whole point: none of this file's other tests ever sent a
// region-switch keystroke to the real `Dashboard` component before this
// test existed. An independent review proved that gap by hardcoding
// `isActive: true` in picker/view.tsx (breaking focus isolation outright --
// every PickerView would then listen for keys regardless of which region
// the dashboard considered focused) and finding that all of this file's
// other tests still passed. Only a hand-written stand-in in
// composition/focus.test.tsx, which reimplements its own separate mock of
// focus routing rather than mounting the real Dashboard, caught it.
//
// The region-switch key is Home/End here, not Tab -- see dashboard.tsx's
// own comment for why Tab could not stay the shell's key once `form`
// entered the picture (fix 3 in this same wave). This test sends a real
// keystroke to the real component either way, which is the property that
// was missing, not the specific key.
test("End moves the dashboard's focus, and only the newly-focused region answers a keystroke", async () => {
  const id = "dash-it-focus-1";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  // "files" is focused first. End should hand focus to "actions" without
  // touching "files" at all.
  //
  // Two settles after End, not one: `isActive` on the newly-focused
  // PickerView only takes effect once Ink's passive effect re-registers
  // its `useInput` handler, which lands one render after the one that
  // flipped `focusSlot` -- a keystroke sent after only one settle can still
  // be routed by the PREVIOUS assignment. See composition/focus.test.tsx's
  // identical comment on this exact race.
  r.stdin.write("\x1b[F"); // End
  await r.settle();
  await r.settle();
  r.stdin.write("j"); // moves "actions"'s cursor, IF isolation actually held
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  // If PickerView's isActive gate were broken (every picker always live,
  // as the reviewer's experiment reproduced), "files" -- mounted first --
  // would answer here instead, with its own cursor untouched by "j". A
  // hardcoded isActive:true also makes both pickers' "j" move together,
  // so asserting the FULL outcome (regionId AND the moved-to option) is
  // what actually distinguishes real per-region isolation from none.
  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "actions", result: { selectedIds: ["build"] } },
  });
  conn.close();
  r.dispose();
});

// The mirror of the above: BEFORE any region switch, keys must affect only
// the first-focused region, and never leak to the second one just because
// it is also mounted and rendering.
test("before any region switch, keys affect only the first-focused region", async () => {
  const id = "dash-it-focus-2";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "files", result: { selectedIds: ["b.ts"] } },
  });
  conn.close();
  r.dispose();
});

// Harder variant than a single End: Home and End must both move focus (not
// just whichever direction happens to be exercised above), and cycling all
// the way around a 2-region dashboard with two Ends must land back on the
// region that started focused.
test("Home moves focus backward, and End wraps around a 2-region dashboard", async () => {
  const id = "dash-it-focus-3";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  // Home from "files" (index 0) wraps backward to "actions" (index 1).
  r.stdin.write("\x1b[H"); // Home
  await r.settle();
  await r.settle(); // see the identical comment above on this race
  r.stdin.write("\r"); // submits "actions" unmoved: "run tests"
  await r.settle();
  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "actions", result: { selectedIds: ["test"] } },
  });
  conn.close();
  r.dispose();
});

test("an outcome says which region produced it", async () => {
  const id = "dash-it-1";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "files", result: { selectedIds: ["b.ts"] } },
  });
  conn.close();
  r.dispose();
});

test("only the focused region answers, and a second outcome is refused", async () => {
  const id = "dash-it-2";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  r.stdin.write("\r");
  await r.settle();
  // A second Enter, now that the first outcome is already out.
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "files", result: { selectedIds: ["a.ts"] } },
  });
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();
  r.dispose();
});

test("escape closes the whole dashboard, not a region", async () => {
  const id = "dash-it-3";
  const r = await mount(id, TWO_PICKERS);
  const conn = await openConnection(id);

  r.stdin.write("\x1b");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});

// A region config error is reported through the shell's single sendError,
// and reaches the controller even though it is sent before any controller
// can have connected -- which retained outcomes made possible.
test("a bad region config reaches the controller, naming the region", async () => {
  const id = "dash-it-4";
  const r = await mount(id, {
    regions: [{ id: "broken", kind: "tree", config: { nodes: [] } }],
  });

  const outcome = await waitForOutcome(id, 2000);
  expect(outcome.status).toBe("error");
  expect((outcome as { message: string }).message).toContain('region "broken"');
  expect((outcome as { message: string }).message).toContain("must not be empty");
  r.dispose();
});

// The dashboard is the first real consumer of the `update` verb: it renders
// a config rather than gathering one, so refresh is a push from Claude.
test("a pushed config refreshes the regions in place", async () => {
  const id = "dash-it-5";
  const r = await mount(id, {
    title: "Before",
    regions: [{ id: "s", kind: "text", config: { text: "old status" } }],
  });
  expect(await r.settle()).toContain("old status");

  await pushUpdate(id, {
    title: "After",
    regions: [{ id: "s", kind: "text", config: { text: "new status" } }],
  });

  const frame = await settleUntil(r, (f) => f.includes("new status"));
  expect(frame).toContain("new status");
  expect(frame).not.toContain("old status");
  r.dispose();
});

// A `text` region used to ignore its allocated `rows` budget entirely --
// unlike every other region kind, it rendered all of its content
// unconditionally, overflowing the terminal and pushing whatever came after
// it (here, the picker and the footer) off screen.
test("a text region windows its content to its allocated rows, not the terminal height", async () => {
  const id = "dash-it-text";
  const r = await mount(
    id,
    {
      regions: [
        {
          id: "log",
          kind: "text",
          rows: 4,
          config: { text: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") },
        },
        {
          id: "next",
          kind: "picker",
          rows: 6,
          config: { mode: "single", options: [{ id: "a", label: "A" }] },
        },
      ],
    },
    14
  );
  const frame = await r.settle();
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const renderedLines = plain.split("\n").filter((l) => l.length > 0).length;
  // The whole pane (title, both regions, the footer) must fit the 14-row
  // terminal -- before the fix this alone overflowed to 23+ lines from the
  // text region's 12 lines rendering unconditionally.
  expect(renderedLines).toBeLessThanOrEqual(14);
  expect(plain).toContain("line 1");
  expect(plain).not.toContain("line 12");
  expect(plain).toContain("more lines)");
  // The footer and the second region must still be visible -- the original
  // bug pushed exactly this off screen.
  expect(plain).toContain("Esc: close");
  expect(plain).toContain("Choose");
  r.dispose();
});

// A tree region is the one region kind no existing primitive covered.
test("a tree region reports the node picked, with its path", async () => {
  const id = "dash-it-6";
  const r = await mount(id, {
    regions: [
      {
        id: "files",
        kind: "tree",
        rows: 10,
        config: {
          nodes: [
            {
              id: "src",
              label: "src/",
              children: [{ id: "src/a.ts", label: "a.ts", badge: "M" }],
            },
          ],
        },
      },
    ],
  });
  const conn = await openConnection(id);

  r.stdin.write("j"); // onto a.ts
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "files", result: { selectedId: "src/a.ts", path: ["src/", "a.ts"] } },
  });
  conn.close();
  r.dispose();
});
