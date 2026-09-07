import { test, expect } from "bun:test";
import { startCanvasServer } from "./server";
import { encodeFrame, FrameDecoder, type CanvasMessage } from "./protocol";

async function talk(port: number, frames: Uint8Array[]): Promise<CanvasMessage[]> {
  const got: CanvasMessage[] = [];
  const dec = new FrameDecoder();
  let closed = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port,
    socket: {
      data(_s, d) { for (const m of dec.push(new Uint8Array(d))) got.push(m as CanvasMessage); },
      close() { closed = true; },
      error() { closed = true; },
    },
  });
  for (const f of frames) socket.write(f);
  await new Promise((r) => setTimeout(r, 60));
  if (!closed) socket.end();
  return got;
}

test("listens on an ephemeral loopback port", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  expect(s.port).toBeGreaterThan(0);
  s.stop();
});

test("accepts the correct token", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  const got = await talk(s.port, [encodeFrame({ type: "hello", token: s.token })]);
  expect(got[0]).toEqual({ type: "hello-ok" });
  s.stop();
});

test("rejects a wrong token and delivers no message", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  const got = await talk(s.port, [
    encodeFrame({ type: "hello", token: "0".repeat(64) }),
    encodeFrame({ type: "get", key: "content" }),
  ]);
  expect(got[0]?.type).toBe("error");
  expect(delivered).toBe(0);
  s.stop();
});

test("rejects a first frame that is not hello", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  const got = await talk(s.port, [encodeFrame({ type: "ping" })]);
  expect(got[0]?.type).toBe("error");
  expect(delivered).toBe(0);
  s.stop();
});

test("routes messages after a successful handshake", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: "hi" });
    },
  });
  const got = await talk(s.port, [
    encodeFrame({ type: "hello", token: s.token }),
    encodeFrame({ type: "get", key: "content" }),
  ]);
  expect(got).toEqual([{ type: "hello-ok" }, { type: "value", key: "content", data: "hi" }]);
  s.stop();
});

test("broadcast reaches an authenticated client", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  const dec = new FrameDecoder();
  const got: CanvasMessage[] = [];
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port: s.port,
    socket: { data(_x, d) { for (const m of dec.push(new Uint8Array(d))) got.push(m as CanvasMessage); } },
  });
  socket.write(encodeFrame({ type: "hello", token: s.token }));
  await new Promise((r) => setTimeout(r, 40));
  s.broadcast({ type: "selected", data: { ok: true } });
  await new Promise((r) => setTimeout(r, 40));
  expect(got).toContainEqual({ type: "selected", data: { ok: true } });
  socket.end();
  s.stop();
});

test("never calls onMessage for an unauthenticated socket even after many frames", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  await talk(s.port, Array.from({ length: 5 }, () => encodeFrame({ type: "ping" })));
  expect(delivered).toBe(0);
  s.stop();
});
