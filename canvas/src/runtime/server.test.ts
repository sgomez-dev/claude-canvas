import { test, expect } from "bun:test";
import { startCanvasServer } from "./server";
import { encodeFrame, FrameDecoder, type CanvasMessage } from "./protocol";
import type { Socket } from "bun";

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
  try {
    for (const f of frames) socket.write(f);
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    if (!closed) socket.end();
  }
  return got;
}

test("listens on an ephemeral loopback port", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    expect(s.port).toBeGreaterThan(0);
  } finally {
    s.stop();
  }
});

test("accepts the correct token", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  try {
    const got = await talk(s.port, [encodeFrame({ type: "hello", token: s.token })]);
    expect(got[0]).toEqual({ type: "hello-ok" });
  } finally {
    s.stop();
  }
});

test("rejects a wrong token and delivers no message", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  try {
    const got = await talk(s.port, [
      encodeFrame({ type: "hello", token: "0".repeat(64) }),
      encodeFrame({ type: "get", key: "content" }),
    ]);
    expect(got[0]?.type).toBe("error");
    expect(delivered).toBe(0);
  } finally {
    s.stop();
  }
});

test("rejects a first frame that is not hello", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  try {
    const got = await talk(s.port, [encodeFrame({ type: "ping" })]);
    expect(got[0]?.type).toBe("error");
    expect(delivered).toBe(0);
  } finally {
    s.stop();
  }
});

test("routes messages after a successful handshake", async () => {
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") reply({ type: "value", key: msg.key, data: "hi" });
    },
  });
  try {
    const got = await talk(s.port, [
      encodeFrame({ type: "hello", token: s.token }),
      encodeFrame({ type: "get", key: "content" }),
    ]);
    expect(got).toEqual([{ type: "hello-ok" }, { type: "value", key: "content", data: "hi" }]);
  } finally {
    s.stop();
  }
});

test("broadcast reaches an authenticated client", async () => {
  const s = await startCanvasServer({ onMessage() {} });
  let socket: Socket<undefined> | undefined;
  try {
    const dec = new FrameDecoder();
    const got: CanvasMessage[] = [];
    socket = await Bun.connect({
      hostname: "127.0.0.1", port: s.port,
      socket: { data(_x, d) { for (const m of dec.push(new Uint8Array(d))) got.push(m as CanvasMessage); } },
    });
    socket.write(encodeFrame({ type: "hello", token: s.token }));
    await new Promise((r) => setTimeout(r, 40));
    s.broadcast({ type: "selected", data: { ok: true } });
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toContainEqual({ type: "selected", data: { ok: true } });
  } finally {
    socket?.end();
    s.stop();
  }
});

test("never calls onMessage for an unauthenticated socket even after many frames", async () => {
  let delivered = 0;
  const s = await startCanvasServer({ onMessage() { delivered++; } });
  try {
    await talk(s.port, Array.from({ length: 5 }, () => encodeFrame({ type: "ping" })));
    expect(delivered).toBe(0);
  } finally {
    s.stop();
  }
});

test("keeps authentication per-connection: one bad socket cannot ride another's auth", async () => {
  // Per-connection auth state exists to stop one authenticated client from
  // blessing every other connection. This test opens two sockets against
  // the same server: one authenticates correctly, the other never does.
  // If auth were tracked as a single server-level flag instead of per
  // socket, socket A's successful hello would flip it for everyone, and
  // socket B's post-hello "get" (despite B's own hello carrying a wrong
  // token) would reach onMessage — which the `delivered` assertion below
  // would catch.
  const delivered: string[] = [];
  const s = await startCanvasServer({
    onMessage(msg, reply) {
      if (msg.type === "get") {
        delivered.push(msg.key);
        reply({ type: "value", key: msg.key, data: "ok" });
      }
    },
  });

  let socketA: Socket<undefined> | undefined;
  let socketB: Socket<undefined> | undefined;
  try {
    const decA = new FrameDecoder();
    const gotA: CanvasMessage[] = [];
    const decB = new FrameDecoder();
    const gotB: CanvasMessage[] = [];

    socketA = await Bun.connect({
      hostname: "127.0.0.1", port: s.port,
      socket: { data(_x, d) { for (const m of decA.push(new Uint8Array(d))) gotA.push(m as CanvasMessage); } },
    });
    socketB = await Bun.connect({
      hostname: "127.0.0.1", port: s.port,
      socket: { data(_x, d) { for (const m of decB.push(new Uint8Array(d))) gotB.push(m as CanvasMessage); } },
    });

    socketA.write(encodeFrame({ type: "hello", token: s.token }));
    socketB.write(encodeFrame({ type: "hello", token: "0".repeat(64) }));
    socketB.write(encodeFrame({ type: "get", key: "bad-key" }));
    await new Promise((r) => setTimeout(r, 60));

    expect(gotA).toEqual([{ type: "hello-ok" }]);
    expect(gotB[0]?.type).toBe("error");

    socketA.write(encodeFrame({ type: "get", key: "good-key" }));
    await new Promise((r) => setTimeout(r, 40));

    // The one thing that matters: nothing socket B sent ever reached
    // onMessage, even though it arrived after a peer had authenticated.
    expect(delivered).toEqual(["good-key"]);

    s.broadcast({ type: "selected", data: { ok: true } });
    await new Promise((r) => setTimeout(r, 40));

    expect(gotA).toContainEqual({ type: "selected", data: { ok: true } });
    expect(gotB).not.toContainEqual({ type: "selected", data: { ok: true } });
  } finally {
    socketA?.end();
    socketB?.end();
    s.stop();
  }
});

// onAuthenticated exists because `broadcast` only reaches connections that
// are ALREADY authenticated, and nothing else could observe when that
// became true. Its absence is why client.test.ts and integration.test.ts
// had to guess with a timer, and why one of those guesses lost the race on
// macos-latest in CI run 34271005232.
test("onAuthenticated fires after hello-ok, with a reply bound to that connection", async () => {
  const order: string[] = [];
  const s = await startCanvasServer({
    onMessage() {},
    onAuthenticated(reply) {
      order.push("authenticated");
      reply({ type: "cancelled", reason: "replayed" });
    },
  });
  try {
    const got = await talk(s.port, [encodeFrame({ type: "hello", token: s.token })]);
    // hello-ok must arrive first: a controller that saw an outcome before
    // its handshake was acknowledged would have no way to know it was
    // authenticated at all.
    expect(got.map((m) => m.type)).toEqual(["hello-ok", "cancelled"]);
    expect(order).toEqual(["authenticated"]);
  } finally {
    s.stop();
  }
});

test("onAuthenticated does not fire for a connection that fails the handshake", async () => {
  let fired = 0;
  const s = await startCanvasServer({
    onMessage() {},
    onAuthenticated() {
      fired++;
    },
  });
  try {
    await talk(s.port, [encodeFrame({ type: "hello", token: "wrong-token" })]);
    expect(fired).toBe(0);
  } finally {
    s.stop();
  }
});

test("a throwing onAuthenticated is routed to onError, not out of the socket callback", async () => {
  const errors: string[] = [];
  const s = await startCanvasServer({
    // ping/pong is the caller's behaviour, not the server's, so it has to
    // be wired here for the liveness assertion below to mean anything.
    onMessage(msg, reply) {
      if (msg.type === "ping") reply({ type: "pong" });
    },
    onAuthenticated() {
      throw new Error("callback exploded");
    },
    onError: (e) => errors.push(e.message),
  });
  try {
    const got = await talk(s.port, [
      encodeFrame({ type: "hello", token: s.token }),
      encodeFrame({ type: "ping" }),
    ]);
    // The connection survives the throw: hello-ok landed and ping is still
    // answered. A canvas process must always be able to exit 0.
    expect(got.map((m) => m.type)).toEqual(["hello-ok", "pong"]);
    expect(errors).toEqual(["callback exploded"]);
  } finally {
    s.stop();
  }
});
