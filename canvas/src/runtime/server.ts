import { encodeFrame, FrameDecoder, type CanvasMessage, type ControllerMessage } from "./protocol";
import { newToken } from "./token";
import { createQueuedWriter, type QueuedWriter } from "./socket-writer";
import type { Socket } from "bun";

export interface CanvasServer {
  port: number;
  token: string;
  broadcast(msg: CanvasMessage): void;
  stop(): void;
}

export interface CanvasServerOptions {
  token?: string;
  onMessage(msg: ControllerMessage, reply: (m: CanvasMessage) => void): void;
  onError?(e: Error): void;
}

interface ConnState {
  authed: boolean;
  rejected: boolean;
  decoder: FrameDecoder;
  // Every outbound byte goes through this rather than socket.write, because
  // socket.write is documented to accept less than it was given under
  // backpressure. See socket-writer.ts for the measurement.
  writer: QueuedWriter;
}

export async function startCanvasServer(o: CanvasServerOptions): Promise<CanvasServer> {
  const token = o.token ?? newToken();
  const conns = new Map<Socket<undefined>, ConnState>();

  const send = (socket: Socket<undefined>, msg: CanvasMessage) => {
    const state = conns.get(socket);
    if (!state) return;
    try {
      // encodeFrame can throw FrameTooLargeError; the writer handles the
      // socket-level failures, so both stay inside this one try.
      state.writer.write(encodeFrame(msg));
    } catch (e) {
      o.onError?.(e as Error);
    }
  };

  // Writes the final frame, then closes on the next tick rather than
  // synchronously. If the peer sent more than one frame back-to-back, the
  // later bytes can already be sitting unread in the kernel's receive
  // buffer when this fires; closing the socket while inbound data is still
  // unread makes the OS send RST instead of FIN, which discards this reply
  // before it reaches the client. Deferring by one tick lets any
  // already-buffered inbound data surface as its own `data` event first
  // (see the `rejected` guard below), so the close no longer races it.
  const sendAndClose = (socket: Socket<undefined>, msg: CanvasMessage) => {
    send(socket, msg);
    const state = conns.get(socket);
    // Not wrapping this would let an uncaught throw here (e.g. the socket
    // was independently destroyed between scheduling and firing) escape a
    // bare timer callback, which crashes the process with a non-zero exit
    // code. A canvas process must always exit 0 — a non-zero exit on
    // Windows leaves a terminal pane nothing can close.
    const endLater = () =>
      setTimeout(() => {
        try {
          socket.end();
        } catch (e) {
          o.onError?.(e as Error);
        }
      }, 0);
    // Wait for the queue to empty before scheduling the close, or a frame
    // still sitting in the writer would be discarded by end(). When nothing
    // is pending -- the case for every frame this path sends, all of which
    // are tiny -- flushed() is already resolved, so this adds one microtask
    // ahead of the setTimeout and preserves the macrotask deferral the
    // comment above depends on (a microtask alone would NOT: microtasks
    // drain before the event loop polls for I/O).
    if (state) void state.writer.flushed().then(endLater, endLater);
    else endLater();
  };

  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        conns.set(socket, {
          authed: false,
          rejected: false,
          decoder: new FrameDecoder(),
          writer: createQueuedWriter(socket, (e) => o.onError?.(e)),
        });
      },
      // Resumes any write that the socket previously refused. Without this
      // handler a frame larger than the send buffer stalls permanently:
      // the writer holds the tail and nothing ever asks it to continue.
      drain(socket) {
        conns.get(socket)?.writer.drain();
      },
      data(socket, data) {
        const state = conns.get(socket);
        if (!state || state.rejected) return;
        let msgs: unknown[];
        try {
          msgs = state.decoder.push(new Uint8Array(data));
        } catch (e) {
          o.onError?.(e as Error);
          state.rejected = true;
          sendAndClose(socket, { type: "error", message: "protocol error" });
          return;
        }
        for (const raw of msgs) {
          const msg = raw as ControllerMessage;
          if (!state.authed) {
            // The first frame must be a matching hello. Anything else closes
            // the connection: this is what makes loopback TCP acceptable.
            if (msg.type !== "hello" || msg.token !== token) {
              state.rejected = true;
              sendAndClose(socket, { type: "error", message: "authentication failed" });
              return;
            }
            state.authed = true;
            send(socket, { type: "hello-ok" });
            continue;
          }
          // o.onMessage is caller-supplied; a throw here is otherwise
          // uncaught inside a runtime-invoked socket callback, which is the
          // same non-zero-exit hazard the deferred close above guards
          // against.
          try {
            o.onMessage(msg, (reply) => send(socket, reply));
          } catch (e) {
            o.onError?.(e as Error);
          }
        }
      },
      close(socket) {
        conns.get(socket)?.writer.destroy();
        conns.delete(socket);
      },
      error(socket, error) {
        o.onError?.(error);
        conns.get(socket)?.writer.destroy();
        conns.delete(socket);
      },
    },
  });

  return {
    port: server.port,
    token,
    broadcast(msg) {
      for (const [socket, state] of conns) if (state.authed) send(socket, msg);
    },
    stop() {
      for (const [socket, state] of conns) {
        state.writer.destroy();
        try {
          socket.end();
        } catch (e) {
          o.onError?.(e as Error);
        }
      }
      conns.clear();
      server.stop();
    },
  };
}
