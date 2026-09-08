// Backpressure-aware writing for the canvas IPC sockets.
//
// `Bun.Socket.write()` is documented as "unbuffered and non-blocking": it
// "can return less than the input size if the socket's buffer is full
// (backpressure)" and returns -1 once the socket is closed or shutting
// down. Both `server.ts` and `client.ts` used to call it and discard the
// return value, so every byte past the kernel's send buffer was silently
// dropped -- the receiver's FrameDecoder then waited forever for a frame
// whose tail was never sent, and no error surfaced anywhere.
//
// Measured on this machine (macOS arm64, Bun 1.4.2, loopback TCP): a single
// 4,000,000-byte write returned 327,212. The remaining 3,672,788 bytes were
// discarded, and the peer received exactly 327,212. That is what made
// `integration.test.ts`'s 4 MB round trip fail on macOS and Linux while
// passing on Windows, whose loopback send buffers absorbed the whole frame
// in one call -- the failure was invisible on the machine the code was
// written on.
//
// This matters beyond that one test: `protocol.ts` advertises a 16 MB frame
// ceiling, the roadmap chose TCP over Unix sockets specifically for "real
// streaming, no message size ceiling", and Phase 3's screenshots are
// multi-megabyte frames by construction.

/**
 * The structural subset of `Bun.Socket` this writer needs. Declared as an
 * interface rather than importing Bun's `Socket` so the queueing logic can
 * be unit-tested against a fake socket that reports whatever backpressure
 * the test wants, with no real I/O and no timing dependence.
 */
export interface WritableSocket {
  write(data: Uint8Array): number;
}

export interface QueuedWriter {
  /**
   * Hands `data` to the socket, queueing whatever the socket refused. Never
   * drops bytes. Safe to call while a previous write is still draining --
   * ordering is preserved.
   */
  write(data: Uint8Array): void;
  /** Call from the socket handler's `drain` callback. */
  drain(): void;
  hasPending(): boolean;
  pendingBytes(): number;
  /**
   * Resolves once every queued byte has been accepted by the socket.
   * Resolves immediately when nothing is pending, so callers that only ever
   * send small frames pay a single microtask and keep their existing
   * timing. Also resolves (rather than rejecting) when `destroy()` discards
   * the queue, so a caller awaiting a flush before closing cannot hang on a
   * socket that died first.
   */
  flushed(): Promise<void>;
  /**
   * Discards the queue and settles anyone awaiting `flushed()`. For use
   * from a socket's `close`/`error` handler: once the socket is gone,
   * `drain` will never fire again and a queued frame would otherwise pin
   * memory and strand its waiters forever.
   */
  destroy(): void;
}

export function createQueuedWriter(
  socket: WritableSocket,
  onError?: (e: Error) => void
): QueuedWriter {
  // Unsent bytes, in order, as a list of views. Deliberately NOT a single
  // re-concatenated buffer: that is the exact O(n^2) growth pattern already
  // documented as deferred debt for FrameDecoder, and a queued 16 MB frame
  // is precisely the case where it would cost seconds. `subarray` returns a
  // view, so consuming a partial write reslices in O(1) without copying.
  let queue: Uint8Array[] = [];
  let queued = 0;
  let waiters: (() => void)[] = [];
  let dead = false;

  const settle = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const pump = () => {
    while (queue.length > 0) {
      const chunk = queue[0]!;
      let written: number;
      try {
        written = socket.write(chunk);
      } catch (e) {
        // A throw here means the socket is unusable. Treat it exactly like
        // the documented -1: drop the queue rather than spin on a socket
        // that will never accept another byte.
        onError?.(e as Error);
        dead = true;
        queue = [];
        queued = 0;
        settle();
        return;
      }
      if (written < 0) {
        // Documented as "socket is closed or shutting down". Nothing queued
        // can ever be delivered, so stop and release the waiters.
        dead = true;
        queue = [];
        queued = 0;
        settle();
        return;
      }
      if (written === 0) return; // send buffer full; resume on `drain`
      queued -= written;
      if (written >= chunk.byteLength) queue.shift();
      else {
        // Partial write. The socket's buffer is full by definition, so keep
        // the tail and wait for `drain` rather than looping on a write that
        // is guaranteed to return 0 next.
        queue[0] = chunk.subarray(written);
        return;
      }
    }
    settle();
  };

  return {
    write(data) {
      if (dead || data.byteLength === 0) return;
      // Fast path: nothing queued, so try the socket directly and only
      // allocate a queue entry for the remainder. This keeps the common
      // case (a small frame that the socket takes whole) identical to the
      // original unbuffered write.
      if (queue.length === 0) {
        let written: number;
        try {
          written = socket.write(data);
        } catch (e) {
          onError?.(e as Error);
          dead = true;
          return;
        }
        if (written < 0) {
          dead = true;
          return;
        }
        if (written >= data.byteLength) return;
        queue.push(data.subarray(Math.max(0, written)));
        queued += data.byteLength - Math.max(0, written);
        return;
      }
      queue.push(data);
      queued += data.byteLength;
      pump();
    },
    drain: pump,
    hasPending: () => queue.length > 0,
    pendingBytes: () => queued,
    flushed() {
      if (queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    destroy() {
      dead = true;
      queue = [];
      queued = 0;
      settle();
    },
  };
}
