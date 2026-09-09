import { test, expect, afterEach } from "bun:test";
import { startCanvasServer } from "./server";
import { writeRecord, deleteRecord, newToken, readRecord } from "./registry";
import { getValue, waitForOutcome, requestClose } from "./client";
import { waitUntil } from "../../test/harness/ipc";

const ids: string[] = [];
afterEach(async () => { for (const id of ids.splice(0)) await deleteRecord(id); });

async function publish(id: string, s: { port: number; token: string }) {
  ids.push(id);
  await writeRecord({ id, kind: "document", scenario: "display", port: s.port,
    token: s.token, pid: process.pid, startedAt: new Date().toISOString(), host: "test" });
}

test("getValue performs the handshake and returns the value", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: { text: "hello" } });
    },
  });
  try {
    await publish("c-get", s);
    expect(await getValue("c-get", "content")).toEqual({ text: "hello" });
  } finally {
    s.stop();
  }
});

// Both of these used to race: they broadcast on a fixed 30 ms timer while
// waitForOutcome was still doing a TCP connect, a filesystem read of the
// registry record, and the hello round trip. `broadcast` only reaches
// ALREADY-AUTHENTICATED connections, so a timer that fires first drops the
// message silently and the wait runs to its full 2000 ms timeout. That is
// what failed on macos-latest in CI run 34271005232, at 2037 ms -- the
// `cancelled` case lost the race that the `selected` case happened to win.
//
// onAuthenticated fires at exactly the moment the handshake completes, with
// a reply bound to that connection, so there is no window to lose and no
// sleep in the test at all.
test("waitForOutcome resolves selected", async () => {
  const s = await startCanvasServer({
    onMessage() {},
    onAuthenticated: (reply) => reply({ type: "selected", data: { slot: 3 } }),
  });
  try {
    await publish("c-sel", s);
    expect(await waitForOutcome("c-sel", 2000)).toEqual({ status: "selected", data: { slot: 3 } });
  } finally {
    s.stop();
  }
});

test("waitForOutcome resolves cancelled", async () => {
  const s = await startCanvasServer({
    onMessage() {},
    onAuthenticated: (reply) => reply({ type: "cancelled", reason: "escape" }),
  });
  try {
    await publish("c-can", s);
    expect(await waitForOutcome("c-can", 2000)).toEqual({ status: "cancelled", reason: "escape" });
  } finally {
    s.stop();
  }
});

test("waitForOutcome returns pending on timeout while the canvas is alive", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    await publish("c-pend", s);
    expect(await waitForOutcome("c-pend", 150)).toEqual({ status: "pending" });
  } finally {
    s.stop();
  }
});

test("waitForOutcome returns disconnected when the canvas goes away", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    await publish("c-gone", s);
    setTimeout(() => s.stop(), 40);
    expect((await waitForOutcome("c-gone", 3000)).status).toBe("disconnected");
  } finally {
    s.stop();
  }
});

test("errors when the canvas id is unknown", async () => {
  expect((await waitForOutcome("c-nobody", 200)).status).toBe("error");
});

test("errors when the registry token is wrong", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    await publish("c-badtok", { port: s.port, token: newToken() });
    expect((await waitForOutcome("c-badtok", 1000)).status).toBe("error");
  } finally {
    s.stop();
  }
});

// Fix 4 (Important). Some canvases (the calendar meeting-picker,
// deliberately) stay open for a few seconds after producing an outcome, to
// show a confirmation, before actually exiting. A real canvas's
// `writeRecordSync` (use-canvas-server.ts's emitOutcome) persists the
// outcome to the registry record BEFORE broadcasting it live, so both
// arrive together. Deleting the registry record the instant a controller
// reads that outcome -- the previous behaviour -- made `close <id>`/a
// second lookup answer "no canvas <id>" for a pane that was still visibly
// open: exactly the unclosable/untrackable-pane failure class this
// project's whole lifecycle design exists to prevent.
test("consuming an outcome does not delete the still-running canvas's record", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: "still-here" });
    },
  });
  const id = "c-live-outcome";
  ids.push(id);
  try {
    // Mirrors what a real canvas's emitOutcome does: persist the outcome to
    // the record (pid: process.pid, i.e. genuinely alive for this test),
    // then it would broadcast the same message live.
    await writeRecord({
      id, kind: "document", scenario: "display", port: s.port, token: s.token,
      pid: process.pid, startedAt: new Date().toISOString(), host: "test",
      outcome: { type: "selected", data: { picked: 1 } }, outcomeAt: new Date().toISOString(),
    });

    expect(await waitForOutcome(id, 2000)).toEqual({ status: "selected", data: { picked: 1 } });

    // The record must survive: this test's own process (standing in for the
    // still-alive canvas) is what `isAlive` checks, and it is definitionally
    // alive here.
    const record = await readRecord(id);
    expect(record).not.toBeNull();
    expect(record?.outcomeConsumed).toBe(true);

    // Genuinely still reachable, not just "a file exists on disk": the
    // record's port/token are still good, because the record (and the
    // server behind it) were never torn down just because the outcome was
    // read.
    expect(await getValue(id, "anything")).toBe("still-here");
  } finally {
    s.stop();
  }
});

test("requestClose sends the close message", async () => {
  let closed = false;
  const s = await startCanvasServer({ onMessage(msg) { if (msg.type === "close") closed = true; } });
  try {
    await publish("c-close", s);
    await requestClose("c-close");
    await waitUntil(() => closed);
    expect(closed).toBe(true);
  } finally {
    s.stop();
  }
});

// Regression test for the RST-drops-the-write race measured during Task 6
// (docs/superpowers/specs/2026-09-07-canvas-foundations-design.md, "Never
// close a socket in the same tick as a final write"): closing a socket
// immediately after a write discards that write via an OS-level RST whenever
// the peer still has unread inbound data queued. requestClose never reads
// after the handshake, so any broadcast the canvas sends in that window sits
// unread on the wire exactly when the (unfixed) code would call socket.end()
// synchronously right after writing {type:"close"}.
//
// To make that window land reliably instead of hoping for a lucky schedule,
// this test floods the connection with broadcasts throughout every trial so
// there is close to always unread data in flight the instant requestClose's
// send+close executes. Measured without the setTimeout(0) deferral in
// client.ts, this fails the vast majority of runs (consistent with Task 6's
// 33/40); with the deferral in place it is expected to pass every run,
// because the deferred close lets the queued `data` event drain first.
test("requestClose still delivers the close frame when inbound data is queued unread", async () => {
  const trials = 20;
  let closes = 0;
  const s = await startCanvasServer({
    onMessage(msg) {
      if (msg.type === "close") closes++;
    },
  });
  const flood = setInterval(() => {
    s.broadcast({ type: "pong" });
  }, 1);
  try {
    for (let i = 0; i < trials; i++) {
      await publish(`c-race-${i}`, s);
      await requestClose(`c-race-${i}`);
    }
    // The last trial's close frame can still be in flight to the server even
    // though requestClose's own promise has already resolved (it resolves
    // once the client-side socket is closed, not once the server has
    // processed the frame). A fixed wait here is exactly the flaky pattern
    // this test exists to avoid elsewhere: poll until the count catches up,
    // rather than assuming any particular delay is enough on every machine.
    const deadline = Date.now() + 2000;
    while (closes < trials && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(closes).toBe(trials);
  } finally {
    clearInterval(flood);
    s.stop();
  }
});
