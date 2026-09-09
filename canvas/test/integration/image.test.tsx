import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Image } from "../../src/canvases/image";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection, pushUpdate } from "../../src/runtime/client";
import { nextOutcome, settleUntil } from "../harness/ipc";
import { encode, pattern } from "../harness/png";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

function png64(width: number, height: number): string {
  return Buffer.from(encode(width, height, 4, pattern(width, height, 4), 0)).toString("base64");
}

const painted = (f: string) => f.includes("▀");
const ESC = "\x1b";

async function mount(node: React.ReactElement, id: string) {
  ids.push(id);
  const r = renderCanvas(node, { columns: 40, rows: 12 });
  await r.settle();
  // `spawn` waits for the record rather than for the pane, and so does this:
  // the server starts asynchronously, so connecting before the record exists
  // is a race, not a failure.
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  return r;
}

// Every canvas must run a server when enabled. A canvas without one writes
// no registry record, so it cannot be listed, read or closed -- `close`
// answers "no canvas <id>" for a pane sitting right there. The calendar's
// display scenario was missing exactly this.
test("the canvas is reachable over a real socket and reports a record", async () => {
  const id = "ipc-image-record";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  const record = await awaitRecord(id, 5000);
  expect(record?.kind).toBe("image");
  expect(record?.scenario).toBe("display");
  r.dispose();
});

test("Escape produces a cancelled outcome, over the socket", async () => {
  const id = "ipc-image-escape";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  await settleUntil(r, painted);

  const conn = await openConnection(id);
  r.stdin.write(ESC);
  const outcome = await nextOutcome(conn);
  expect(outcome).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});

// A pushed config is a new image, and the view is remounted on a generation
// counter rather than reset by hand.
test("a pushed config replaces the image", async () => {
  const id = "ipc-image-update";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  expect(await settleUntil(r, (f) => f.includes("8×8"))).toContain("8×8");

  await pushUpdate(id, { data: png64(20, 10), title: "pushed" });
  const frame = await settleUntil(r, (f) => f.includes("20×10"));
  expect(frame).toContain("pushed");
  expect(frame).toContain("▀");
  r.dispose();
});

// The decode happens in the shell, one tick after the config arrives, so a
// pushed config that fails must reach the controller the same way a
// malformed one does -- through the single error channel, not as a silent
// blank frame.
test("a pushed payload that is not a PNG is reported as an error", async () => {
  const id = "ipc-image-bad-push";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  await settleUntil(r, painted);

  const conn = await openConnection(id);
  await pushUpdate(id, { data: Buffer.from("still not a png").toString("base64") });
  const outcome = await nextOutcome(conn);
  expect(outcome?.type).toBe("error");
  expect((outcome as { message: string }).message).toMatch(/could not read inline data.*not a PNG/i);
  conn.close();
  r.dispose();
});

// Pins what actually happens, which is not what I assumed when writing this
// canvas: a config error is a TERMINAL outcome, so the first one is the only
// one the canvas will ever produce. useCanvasServer's emitOutcome returns
// early once an outcome exists, by design -- "a controller can never read
// one of two contradictory answers" -- and the retained outcome is replayed
// to every controller that authenticates later. So a second bad config
// reports nothing new, and a controller connecting afterwards is handed the
// FIRST error, not the current state.
//
// Worth knowing before writing a controller that pushes configs in a loop:
// once one is rejected, the canvas has spent its single answer.
test("a config error is terminal: the second bad config reports nothing new", async () => {
  const id = "ipc-image-two-errors";
  const r = await mount(<Image id={id} config={{}} enabled={true} />, id);

  const conn = await openConnection(id);
  const first = await nextOutcome(conn);
  expect(first?.type).toBe("error");
  expect((first as { message: string }).message).toBe("image config: needs a 'path' or 'data'");

  // A different problem, pushed onto the same canvas.
  await pushUpdate(id, { path: "b.png", data: "abc" });
  // Nothing further arrives on the connection that already has the outcome.
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();

  // And a controller attaching now is replayed the first error, not the
  // second problem -- which the frame on screen does show.
  const later = await openConnection(id);
  const replayed = await nextOutcome(later);
  expect((replayed as { message: string }).message).toBe(
    "image config: needs a 'path' or 'data'"
  );
  later.close();
  expect(await r.settle()).toContain("not both");
  r.dispose();
});

test("a malformed config is reported over the socket, not just rendered", async () => {
  const id = "ipc-image-bad-config";
  const r = await mount(<Image id={id} config={{ path: "a.png", data: "abc" }} enabled={true} />, id);
  const conn = await openConnection(id);
  const outcome = await nextOutcome(conn);
  expect(outcome?.type).toBe("error");
  expect((outcome as { message: string }).message).toBe(
    "image config: give either 'path' or 'data', not both"
  );
  conn.close();
  r.dispose();
});
