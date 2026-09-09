import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Dashboard } from "../../src/canvases/dashboard";
import type { DashboardConfig } from "../../src/canvases/dashboard/types";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection } from "../../src/runtime/client";
import { nextOutcome } from "../harness/ipc";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

// Region-switching moved off Tab and onto Home/End because `form` binds Tab
// to its own field navigation. Every dashboard test written for that fix
// used `text`, `picker`, `tree` or `table` regions -- so the two region
// kinds whose own key handling motivated the change, `form` and `diff`, had
// no dashboard coverage at all. The behaviour turned out to be correct;
// nothing proved it, which is the same shape as the focus-routing gap the
// review found in this file's neighbour.

const FORM_AND_PICKER: DashboardConfig = {
  title: "Form beside a picker",
  regions: [
    {
      id: "bug",
      kind: "form",
      title: "Report",
      rows: 12,
      config: {
        fields: [
          { id: "who", type: "text", label: "Who" },
          { id: "what", type: "text", label: "What" },
        ],
      },
    },
    {
      id: "next",
      kind: "picker",
      title: "Then",
      rows: 8,
      config: {
        mode: "single",
        options: [
          { id: "fix", label: "fix it" },
          { id: "skip", label: "skip" },
        ],
      },
    },
  ],
};

const DIFF_AND_PICKER: DashboardConfig = {
  title: "Diff beside a picker",
  regions: [
    {
      id: "change",
      kind: "diff",
      title: "Proposed",
      rows: 12,
      config: {
        diffText:
          "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    },
    {
      id: "next",
      kind: "picker",
      title: "Then",
      rows: 8,
      config: {
        mode: "single",
        options: [{ id: "apply", label: "apply it" }],
      },
    },
  ],
};

async function mount(id: string, config: DashboardConfig) {
  ids.push(id);
  const r = renderCanvas(<Dashboard id={id} config={config} enabled={true} />, {
    columns: 60,
    rows: 30,
  });
  await r.settle();
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  return r;
}

/**
 * Two settles, not one: `isActive` on the newly-focused view only takes
 * effect once Ink's passive effect re-registers its `useInput` handler,
 * which lands one render after the one that changed focus. A keystroke sent
 * after a single settle is still routed by the previous assignment.
 */
async function switchRegion(r: Awaited<ReturnType<typeof mount>>, key: "home" | "end") {
  r.stdin.write(key === "end" ? "\x1b[F" : "\x1b[H");
  await r.settle();
  await r.settle();
}

// The collision itself. If region-switching were still on Tab, this Tab
// would move the region instead of the form's field, and the form could
// never be filled past its first field.
test("Tab moves a form region's fields, not the dashboard's regions", async () => {
  const r = await mount("dash-fd-1", FORM_AND_PICKER);
  expect(await r.settle()).toContain("> Who");

  r.stdin.write("\t");
  const afterTab = await r.settle();
  expect(afterTab).toContain("> What");
  // And focus did not jump to the picker.
  expect(afterTab).not.toContain("> fix it");
  r.dispose();
});

test("a form region can be filled in and submitted, tagged with its region", async () => {
  const r = await mount("dash-fd-2", FORM_AND_PICKER);
  await r.settle();
  const conn = await openConnection("dash-fd-2");

  for (const ch of ["a", "n", "a"]) {
    r.stdin.write(ch);
    await r.settle();
  }
  // Tab past both fields onto the form's own Submit button, then Enter.
  r.stdin.write("\t");
  await r.settle();
  r.stdin.write("\t");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "bug", result: { values: { who: "ana", what: "" } } },
  });
  conn.close();
  r.dispose();
});

test("End leaves a focused form and the next region answers instead", async () => {
  const r = await mount("dash-fd-3", FORM_AND_PICKER);
  await r.settle();
  const conn = await openConnection("dash-fd-3");

  await switchRegion(r, "end");
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: { regionId: "next", result: { selectedIds: ["fix"] } },
  });
  conn.close();
  r.dispose();
});

// `diff` has the densest key set of any region kind -- a/r for decisions,
// PgUp/PgDn to scroll a hunk, Enter to submit -- and none of it had ever
// been driven inside a dashboard.
test("a diff region takes its own keys and submits its decisions", async () => {
  const r = await mount("dash-fd-4", DIFF_AND_PICKER);
  expect(await r.settle()).toContain("[undecided]");
  const conn = await openConnection("dash-fd-4");

  r.stdin.write("a"); // approve the only hunk
  expect(await r.settle()).toContain("[approved]");
  r.stdin.write("\r");
  await r.settle();

  expect(await nextOutcome(conn, 2000)).toEqual({
    type: "selected",
    data: {
      regionId: "change",
      result: { decisions: [{ hunkId: "x.txt#0", decision: "approved" }] },
    },
  });
  conn.close();
  r.dispose();
});

// The mirror: a diff region must not consume keys once focus has left it.
test("a diff region stops taking keys once focus moves off it", async () => {
  const r = await mount("dash-fd-5", DIFF_AND_PICKER);
  await r.settle();

  await switchRegion(r, "end");
  // "a" is the diff's approve key. With focus on the picker it must do
  // nothing to the diff at all.
  r.stdin.write("a");
  const frame = await r.settle();
  expect(frame).toContain("[undecided]");
  expect(frame).not.toContain("[approved]");
  r.dispose();
});
