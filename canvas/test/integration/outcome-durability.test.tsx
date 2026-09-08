import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Picker } from "../../src/canvases/picker";
import type { PickerConfig } from "../../src/canvases/picker/types";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord, listRecords, readRecord } from "../../src/runtime/registry";
import { waitForOutcome } from "../../src/runtime/client";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

const CONFIG: PickerConfig = {
  mode: "single",
  options: [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ],
};

async function mount(id: string, config: PickerConfig = CONFIG) {
  ids.push(id);
  const r = renderCanvas(<Picker id={id} config={config} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  await r.settle();
  // The server starts asynchronously; the record appearing is the signal
  // that it is up, which is the same signal `spawn` now waits for.
  const record = await awaitRecord(id, 5000);
  expect(record).not.toBeNull();
  return r;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// THE regression this whole mechanism exists for. Before outcomes were
// retained, a canvas broadcast its answer to whoever was connected at that
// instant and kept nothing: choose before the controller's `wait` connects
// and the choice was gone, permanently. Verified in a real tmux pane on
// 2026-09-08, where `wait` answered {"status":"error","message":"no canvas
// sm-race"} after the user had already picked.
test("a selection made with no controller attached is still delivered", async () => {
  const id = "durable-early";
  const r = await mount(id);

  // Nobody is connected. This is the losing race.
  r.stdin.write("\r");
  await r.settle();

  expect(await waitForOutcome(id, 2000)).toEqual({
    status: "selected",
    data: { selectedIds: ["alpha"] },
  });
  r.dispose();
});

// One step worse than the test above: the canvas is not merely unattached,
// it is gone. Its record has to outlive it.
test("an outcome survives the canvas unmounting entirely", async () => {
  const id = "durable-dead";
  const r = await mount(id);

  r.stdin.write("j");
  await r.settle();
  r.stdin.write("\r");
  await r.settle();

  r.dispose();
  await sleep(60); // the hook's cleanup is a passive effect

  const record = await readRecord(id);
  expect(record?.outcome).toEqual({ type: "selected", data: { selectedIds: ["beta"] } });
  expect(await waitForOutcome(id, 2000)).toEqual({
    status: "selected",
    data: { selectedIds: ["beta"] },
  });
});

test("reading an outcome consumes it, so it is never reported twice", async () => {
  const id = "durable-once";
  const r = await mount(id);
  r.stdin.write("\r");
  await r.settle();
  r.dispose();
  await sleep(60);

  expect((await waitForOutcome(id, 2000)).status).toBe("selected");
  // The record is gone, so a second wait finds nothing rather than
  // re-reporting a choice the controller has already acted on.
  const second = await waitForOutcome(id, 300);
  expect(second.status).toBe("error");
  expect(await readRecord(id)).toBeNull();
});

test("cancelled survives the same way selected does", async () => {
  const id = "durable-cancel";
  const r = await mount(id);
  r.stdin.write("\x1b");
  await r.settle();
  r.dispose();
  await sleep(60);

  expect(await waitForOutcome(id, 2000)).toEqual({ status: "cancelled", reason: "escape" });
});

// The case the ledger recorded as effectively unobservable: a config error
// is reported as soon as the canvas's own server is up, which is always
// before a controller can have read the port from the registry record. It
// was rendered in the pane, so a human saw it; Claude never did.
test("a config error reaches the controller instead of being lost", async () => {
  const id = "durable-configerr";
  const r = await mount(id, { mode: "single", options: [] } as PickerConfig);

  const outcome = await waitForOutcome(id, 2000);
  expect(outcome.status).toBe("error");
  expect((outcome as { message: string }).message).toContain("must not be empty");
  r.dispose();
});

test("a record that exists only to carry an outcome is not listed as a live canvas", async () => {
  const id = "durable-notlisted";
  const r = await mount(id);
  expect((await listRecords()).map((x) => x.id)).toContain(id);

  r.stdin.write("\r");
  await r.settle();
  r.dispose();
  await sleep(60);

  // The record is still there, and still readable...
  expect((await readRecord(id))?.outcome).toBeDefined();
  // ...but it is not a canvas anyone can interact with.
  expect((await listRecords()).map((x) => x.id)).not.toContain(id);
});
