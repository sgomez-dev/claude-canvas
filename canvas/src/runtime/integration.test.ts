import { test, expect, afterEach } from "bun:test";
import { startCanvasServer } from "./server";
import { writeRecord, deleteRecord } from "./registry";
import { openConnection, waitForOutcome, getValue } from "./client";
import { waitUntil } from "../../test/harness/ipc";
import type { ControllerMessage } from "./protocol";

const ids: string[] = [];
afterEach(async () => { for (const id of ids.splice(0)) await deleteRecord(id); });

// The regression test for the original defect: user selections never reached
// the controller in two of three canvases. Runs with no tmux, no Windows
// Terminal, and no terminal at all — which is what makes CI possible.
test("full round trip: ready, update, get, selected, close", async () => {
  const seen: ControllerMessage[] = [];
  let config: unknown = { content: "v1" };
  let closed = false;

  // Armed just before waitForOutcome runs, so the outcome is handed to
  // waitForOutcome's own connection the instant it authenticates. The
  // previous form broadcast on a fixed 40 ms timer, which races the
  // handshake for the same reason client.test.ts's two did -- broadcast
  // only reaches already-authenticated connections.
  let armed = false;
  const server = await startCanvasServer({
    onMessage(msg, reply) {
      seen.push(msg);
      if (msg.type === "update") config = msg.config;
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: config });
      if (msg.type === "close") closed = true;
    },
    onAuthenticated(reply) {
      if (armed) reply({ type: "selected", data: { offset: 7 } });
    },
  });

  const id = "it-round";
  ids.push(id);
  let conn: Awaited<ReturnType<typeof openConnection>> | undefined;
  try {
    await writeRecord({ id, kind: "document", scenario: "edit", port: server.port,
      token: server.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });

    conn = await openConnection(id);
    server.broadcast({ type: "ready", scenario: "edit", capabilities: { graphics: "none" } });
    expect((await conn.next(1000))?.type).toBe("ready");

    conn.send({ type: "update", config: { content: "v2" } });
    await waitUntil(() => (config as { content?: string })?.content === "v2");
    expect(await getValue(id, "content")).toEqual({ content: "v2" });

    armed = true;
    expect(await waitForOutcome(id, 3000)).toEqual({ status: "selected", data: { offset: 7 } });
    armed = false;

    conn.send({ type: "close" });
    await waitUntil(() => closed);
    expect(closed).toBe(true);
  } finally {
    conn?.close();
    server.stop();
  }
});

test("a payload larger than the old newline protocol could carry survives", async () => {
  // Phase 3 will send screenshots. 4 MB of base64-ish text with newlines.
  const big = "QUJD\n".repeat(800_000);
  let received = "";
  const server = await startCanvasServer({
    onMessage(msg) { if (msg.type === "update") received = (msg.config as { blob: string }).blob; },
  });
  const id = "it-big";
  ids.push(id);
  let conn: Awaited<ReturnType<typeof openConnection>> | undefined;
  try {
    await writeRecord({ id, kind: "document", scenario: "display", port: server.port,
      token: server.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });

    conn = await openConnection(id);
    conn.send({ type: "update", config: { blob: big } });
    // A 4 MB frame needs many event-loop turns to arrive and decode; poll
    // for it rather than guessing a fixed wall-clock budget (the same
    // reasoning as the poll a few lines below, for the other direction).
    await waitUntil(() => received.length === big.length, 10_000);
    expect(received.length).toBe(big.length);
  } finally {
    conn?.close();
    server.stop();
  }
});

// The mirror of the test above, for the other direction. The 4 MB `update`
// exercises client.ts's writer (controller -> canvas); this exercises
// server.ts's (canvas -> controller). Both sides called socket.write and
// discarded its return value, so both truncated large frames -- but only the
// controller-side path had a test, and it passed on Windows (whose loopback
// send buffers absorbed 4 MB in one call) while failing on macOS and Linux.
test("a large frame survives the canvas -> controller direction too", async () => {
  const big = "QUJD\n".repeat(800_000);
  const server = await startCanvasServer({ onMessage() {} });
  const id = "it-big-out";
  ids.push(id);
  let conn: Awaited<ReturnType<typeof openConnection>> | undefined;
  try {
    await writeRecord({ id, kind: "document", scenario: "display", port: server.port,
      token: server.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });

    conn = await openConnection(id);
    server.broadcast({ type: "selected", data: { blob: big } });

    // Poll rather than sleeping a fixed interval: a 4 MB frame needs many
    // drain cycles, and the point of the test is that it completes at all,
    // not that it completes within some arbitrary wall-clock budget.
    const deadline = Date.now() + 10_000;
    let msg = await conn.next(Math.max(0, deadline - Date.now()));
    while (msg && msg.type !== "selected" && Date.now() < deadline) {
      msg = await conn.next(Math.max(0, deadline - Date.now()));
    }
    expect(msg?.type).toBe("selected");
    expect((msg as { data: { blob: string } }).data.blob.length).toBe(big.length);
  } finally {
    conn?.close();
    server.stop();
  }
});
