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
