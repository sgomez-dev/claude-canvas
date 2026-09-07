import { test, expect, afterEach } from "bun:test";
import { startCanvasServer } from "./server";
import { writeRecord, deleteRecord, newToken } from "./registry";
import { getValue, waitForOutcome, requestClose } from "./client";

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

test("waitForOutcome resolves selected", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    await publish("c-sel", s);
    setTimeout(() => s.broadcast({ type: "selected", data: { slot: 3 } }), 30);
    expect(await waitForOutcome("c-sel", 2000)).toEqual({ status: "selected", data: { slot: 3 } });
  } finally {
    s.stop();
  }
});

test("waitForOutcome resolves cancelled", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    await publish("c-can", s);
    setTimeout(() => s.broadcast({ type: "cancelled", reason: "escape" }), 30);
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

test("requestClose sends the close message", async () => {
  let closed = false;
  const s = await startCanvasServer({ onMessage(msg) { if (msg.type === "close") closed = true; } });
  try {
    await publish("c-close", s);
    await requestClose("c-close");
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toBe(true);
  } finally {
    s.stop();
  }
});
