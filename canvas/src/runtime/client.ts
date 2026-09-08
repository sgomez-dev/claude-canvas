import {
  encodeFrame,
  FrameDecoder,
  type CanvasMessage,
  type ControllerMessage,
  type OutcomeMessage,
} from "./protocol";
import { deleteRecord, readRecord } from "./registry";
import { createQueuedWriter, type QueuedWriter } from "./socket-writer";

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

  // Assigned immediately after Bun.connect resolves, which is before any
  // caller can invoke send() and therefore before `drain` can ever fire --
  // the null guards below are for type-safety, not a real ordering window.
  let writer: QueuedWriter | null = null;

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(_s, data) {
        // Mirrors server.ts's equivalent handler: decoder.push can throw on
        // a malformed/oversized frame, and an uncaught throw here would
        // escape a runtime-invoked socket callback as an unhandled
        // rejection/crash. Treat a decode failure the same as the
        // connection dying, via the same die() path close/error already use.
        try {
          for (const raw of decoder.push(new Uint8Array(data))) settle(raw as CanvasMessage);
        } catch {
          die();
        }
      },
      // Resumes a write the socket previously refused under backpressure.
      // The controller is the side that sends `update`, which Phase 3 will
      // use for multi-megabyte screenshots, so this is the handler that
      // makes a large outbound config possible at all.
      drain() {
        writer?.drain();
      },
      close() {
        writer?.destroy();
        die();
      },
      error() {
        writer?.destroy();
        die();
      },
    },
  });
  writer = createQueuedWriter(socket, die);

  const conn: Connection = {
    send(msg) {
      // encodeFrame's FrameTooLargeError still propagates to the caller, as
      // it did when this wrote to the socket directly. What changed is that
      // the bytes now survive backpressure instead of being truncated.
      if (!dead) writer?.write(encodeFrame(msg));
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
      // Releases anyone awaiting flushed() and drops any queued tail: this
      // is a teardown path, and after end() the socket will never accept
      // those bytes anyway. Callers that need a frame delivered before
      // closing (requestClose) send small frames, which the writer's fast
      // path hands to the socket synchronously with nothing left queued.
      writer?.destroy();
      // The socket may already be gone (peer closed first, or a previous
      // close() call already tore it down) — end() on a dead socket throws,
      // and an uncaught throw here would escape whatever caller invoked
      // close(), several of which run inside `finally` blocks.
      try {
        socket.end();
      } catch {
        // already closed/destroyed; nothing further to do.
      }
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
  // Measured during Task 6 on this platform: writing a frame and calling
  // end() synchronously right after discards the frame via an OS-level RST
  // whenever the peer still has unread inbound data queued on this socket
  // (e.g. a broadcast that arrived while we were mid-handshake and was never
  // drained, since this function never calls conn.next()). 33/40 failures
  // with an immediate close, 0/60 with the close deferred by one tick. A
  // dropped close frame here means the canvas is never asked to exit, which
  // is exactly how a zombie pane appears — nothing else can remove one on
  // Windows. Deferring with setTimeout (a macrotask) lets any already-queued
  // inbound data surface as its own `data` event and get drained first, so
  // the close no longer races the write. queueMicrotask does NOT work here:
  // microtasks drain before the event loop polls for I/O, so the race would
  // be unchanged.
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      conn.close();
      resolve();
    }, 0);
  });
}

function toWaitResult(msg: OutcomeMessage): WaitResult {
  if (msg.type === "selected") return { status: "selected", data: msg.data };
  if (msg.type === "cancelled") return { status: "cancelled", reason: msg.reason };
  return { status: "error", message: msg.message };
}

/**
 * Reads and removes a persisted outcome, if the canvas left one.
 *
 * Removing it is what keeps `wait` from reporting the same choice twice,
 * and it is the only thing that deletes these records in the normal case --
 * the canvas deliberately does not delete its own record when it exits with
 * an unread outcome.
 */
async function consumeOutcome(id: string): Promise<OutcomeMessage | null> {
  let record;
  try {
    record = await readRecord(id);
  } catch {
    return null;
  }
  if (!record?.outcome) return null;
  await deleteRecord(id);
  return record.outcome;
}

export async function waitForOutcome(
  id: string,
  timeoutMs: number = DEFAULT_WAIT_MS
): Promise<WaitResult> {
  // A persisted outcome is checked first and is authoritative. The canvas
  // writes it before broadcasting and before exiting, so this covers every
  // case the socket cannot: the user chose before this call connected, or
  // the canvas has already exited entirely.
  const persisted = await consumeOutcome(id);
  if (persisted) return toWaitResult(persisted);

  let conn: Connection;
  try {
    conn = await openConnection(id);
  } catch (e) {
    // The canvas can produce its outcome and exit in the gap between the
    // check above and this connect, so look once more before reporting a
    // failure that would discard the answer.
    const late = await consumeOutcome(id);
    if (late) return toWaitResult(late);
    return { status: "error", message: (e as Error).message };
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "pending" };
      const msg = await conn.next(remaining);
      if (msg === null) {
        // Same reasoning as above, for a canvas that exited mid-wait.
        const late = await consumeOutcome(id);
        if (late) return toWaitResult(late);
        return Date.now() >= deadline ? { status: "pending" } : { status: "disconnected" };
      }
      if (msg.type === "selected" || msg.type === "cancelled" || msg.type === "error") {
        // Delivered over the socket, so drop the persisted copy: leaving it
        // would make a second `wait` report an outcome already acted on.
        await consumeOutcome(id);
        return toWaitResult(msg);
      }
      // ready / value / pong / hello-ok are not outcomes; keep waiting.
    }
  } finally {
    conn.close();
  }
}
