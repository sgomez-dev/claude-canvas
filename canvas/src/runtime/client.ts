import { encodeFrame, FrameDecoder, type CanvasMessage, type ControllerMessage } from "./protocol";
import { readRecord } from "./registry";

export const DEFAULT_WAIT_MS = 55_000;

export type WaitResult =
  | { status: "selected"; data: unknown }
  | { status: "cancelled"; reason?: string }
  | { status: "pending" }
  | { status: "disconnected" }
  | { status: "error"; message: string };

export interface Connection {
  send(msg: ControllerMessage): void;
  next(timeoutMs: number): Promise<CanvasMessage | null>;
  close(): void;
}

class NoSuchCanvasError extends Error {}

export async function openConnection(id: string): Promise<Connection> {
  const record = await readRecord(id);
  if (!record) throw new NoSuchCanvasError(`no canvas ${id}`);
  if (record.lastError) throw new Error(record.lastError);

  const inbox: CanvasMessage[] = [];
  const waiters: ((m: CanvasMessage | null) => void)[] = [];
  let dead = false;
  const decoder = new FrameDecoder();

  const settle = (m: CanvasMessage | null) => {
    const w = waiters.shift();
    if (w) w(m);
    else if (m) inbox.push(m);
  };
  const die = () => {
    dead = true;
    while (waiters.length) waiters.shift()?.(null);
  };

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(_s, data) {
        for (const raw of decoder.push(new Uint8Array(data))) settle(raw as CanvasMessage);
      },
      close: die,
      error: die,
    },
  });

  const conn: Connection = {
    send(msg) {
      if (!dead) socket.write(encodeFrame(msg));
    },
    next(timeoutMs) {
      const buffered = inbox.shift();
      if (buffered) return Promise.resolve(buffered);
      if (dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(handler);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const handler = (m: CanvasMessage | null) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(handler);
      });
    },
    close() {
      socket.end();
    },
  };

  conn.send({ type: "hello", token: record.token });
  const ack = await conn.next(3000);
  if (!ack || ack.type !== "hello-ok") {
    conn.close();
    throw new Error(ack?.type === "error" ? ack.message : "handshake failed");
  }
  return conn;
}

export async function getValue(id: string, key: string): Promise<unknown> {
  const conn = await openConnection(id);
  try {
    conn.send({ type: "get", key });
    for (;;) {
      const msg = await conn.next(3000);
      if (!msg) throw new Error("no response");
      if (msg.type === "value" && msg.key === key) return msg.data;
      if (msg.type === "error") throw new Error(msg.message);
    }
  } finally {
    conn.close();
  }
}

export async function requestClose(id: string): Promise<void> {
  const conn = await openConnection(id);
  // Closing is always a request. Never kill the process: on Windows a
  // non-zero exit leaves a pane that no command can remove.
  conn.send({ type: "close" });
  conn.close();
  return;
  // Deferred by one tick rather than closed synchronously. This is a
  // send-then-close path, same shape as server.ts's sendAndClose, and pays
  // the same tax: closing a socket while the peer still has unread inbound
  // data queued makes the OS send RST instead of FIN, which discards the
  // write we just made before it reaches the wire. Task 6 measured this on
  // this exact platform: 33 failures in 40 runs with an immediate close, 0
  // in 60 with the close deferred one tick. Must be a macrotask
  // (setTimeout), not queueMicrotask — microtasks drain before the event
  // loop returns to the I/O poll phase, so a microtask-deferred close would
  // race the write exactly as an undeferred one does.
  //
  // This matters more here than in server.ts: a dropped close frame means
  // the canvas is never asked to exit, and nothing else can remove a
  // terminal pane on Windows — a lost close message is exactly how a
  // zombie pane appears.
  setTimeout(() => {
    // Guarded so a throw here (e.g. the socket was independently destroyed
    // between scheduling and firing) cannot escape a bare timer callback as
    // an uncaught exception, which would crash the controller process.
    try {
      conn.close();
    } catch {
      // best effort; the socket is going away regardless
    }
  }, 0);
}

export async function waitForOutcome(
  id: string,
  timeoutMs: number = DEFAULT_WAIT_MS
): Promise<WaitResult> {
  let conn: Connection;
  try {
    conn = await openConnection(id);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "pending" };
      const msg = await conn.next(remaining);
      if (msg === null) {
        return Date.now() >= deadline ? { status: "pending" } : { status: "disconnected" };
      }
      if (msg.type === "selected") return { status: "selected", data: msg.data };
      if (msg.type === "cancelled") return { status: "cancelled", reason: msg.reason };
      if (msg.type === "error") return { status: "error", message: msg.message };
      // ready / value / pong / hello-ok are not outcomes; keep waiting.
    }
  } finally {
    conn.close();
  }
}
