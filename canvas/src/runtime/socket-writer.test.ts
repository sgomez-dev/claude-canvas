import { test, expect } from "bun:test";
import { createQueuedWriter, type WritableSocket } from "./socket-writer";

// A socket whose backpressure is scripted, so every case below is exact and
// timing-independent. `accept` is consulted per write() call and returns how
// many bytes this particular call will take (-1 to report a closed socket).
function fakeSocket(accept: (offered: number, call: number) => number) {
  const received: number[] = [];
  let calls = 0;
  const socket: WritableSocket = {
    write(data) {
      const n = accept(data.byteLength, calls++);
      if (n < 0) return n;
      const taken = Math.min(n, data.byteLength);
      for (let i = 0; i < taken; i++) received.push(data[i]!);
      return taken;
    },
  };
  return { socket, received, callCount: () => calls };
}

const bytes = (...v: number[]) => new Uint8Array(v);

test("a write the socket accepts whole goes straight through and queues nothing", () => {
  const f = fakeSocket((offered) => offered);
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3));
  expect(f.received).toEqual([1, 2, 3]);
  expect(w.hasPending()).toBe(false);
  expect(w.pendingBytes()).toBe(0);
});

// The regression test for the real defect: socket.write is documented to
// "return less than the input size if the socket's buffer is full". A
// 4,000,000-byte write measured 327,212 accepted on this machine, and the
// remaining bytes used to be discarded with no error anywhere.
test("a partial write keeps the remainder and drain() delivers it in order", () => {
  let allowAll = false;
  const f = fakeSocket((offered) => (allowAll ? offered : 2));
  const w = createQueuedWriter(f.socket);

  w.write(bytes(1, 2, 3, 4, 5));
  expect(f.received).toEqual([1, 2]);
  expect(w.hasPending()).toBe(true);
  expect(w.pendingBytes()).toBe(3);

  allowAll = true;
  w.drain();
  expect(f.received).toEqual([1, 2, 3, 4, 5]);
  expect(w.hasPending()).toBe(false);
});

test("writes queued behind a stalled write are delivered in their original order", () => {
  let allowAll = false;
  const f = fakeSocket((offered) => (allowAll ? offered : 0));
  const w = createQueuedWriter(f.socket);

  w.write(bytes(1, 2));
  w.write(bytes(3, 4));
  w.write(bytes(5));
  expect(f.received).toEqual([]);
  expect(w.pendingBytes()).toBe(5);

  allowAll = true;
  w.drain();
  expect(f.received).toEqual([1, 2, 3, 4, 5]);
});

test("a socket that accepts one byte per call still delivers everything across drains", () => {
  const f = fakeSocket(() => 1);
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3, 4));
  // Each drain moves exactly one byte, so the queue needs one drain per
  // remaining byte — the point is that nothing is ever lost or reordered.
  for (let i = 0; i < 10 && w.hasPending(); i++) w.drain();
  expect(f.received).toEqual([1, 2, 3, 4]);
  expect(w.hasPending()).toBe(false);
});

test("write() returning -1 stops the writer instead of spinning on a dead socket", () => {
  const f = fakeSocket(() => -1);
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3));
  expect(f.received).toEqual([]);
  expect(w.hasPending()).toBe(false);
  // Subsequent writes must not reach the socket at all.
  const before = f.callCount();
  w.write(bytes(4));
  expect(f.callCount()).toBe(before);
});

test("a -1 discovered while draining a queued tail releases the queue", () => {
  let closed = false;
  const f = fakeSocket((offered) => (closed ? -1 : Math.min(1, offered)));
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3));
  expect(w.hasPending()).toBe(true);
  closed = true;
  w.drain();
  expect(w.hasPending()).toBe(false);
  expect(w.pendingBytes()).toBe(0);
});

test("flushed() resolves immediately when nothing is pending", async () => {
  const f = fakeSocket((offered) => offered);
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1));
  await w.flushed(); // must not hang
  expect(w.hasPending()).toBe(false);
});

test("flushed() resolves only once the queue has actually emptied", async () => {
  let allowAll = false;
  const f = fakeSocket((offered) => (allowAll ? offered : 0));
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3));

  let resolved = false;
  const flushed = w.flushed().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  allowAll = true;
  w.drain();
  await flushed;
  expect(resolved).toBe(true);
});

test("destroy() drops the queue and settles anyone awaiting flushed()", async () => {
  const f = fakeSocket(() => 0);
  const w = createQueuedWriter(f.socket);
  w.write(bytes(1, 2, 3));
  const flushed = w.flushed();
  w.destroy();
  await flushed; // must not hang: the socket is gone, drain will never fire
  expect(w.hasPending()).toBe(false);
  expect(w.pendingBytes()).toBe(0);
});

test("a throwing socket routes to onError instead of escaping write()", () => {
  const errors: string[] = [];
  const socket: WritableSocket = {
    write() {
      throw new Error("socket is gone");
    },
  };
  const w = createQueuedWriter(socket, (e) => errors.push(e.message));
  expect(() => w.write(bytes(1, 2, 3))).not.toThrow();
  expect(errors).toEqual(["socket is gone"]);
  expect(w.hasPending()).toBe(false);
});

test("an empty write is a no-op and never reaches the socket", () => {
  const f = fakeSocket((offered) => offered);
  const w = createQueuedWriter(f.socket);
  w.write(new Uint8Array(0));
  expect(f.callCount()).toBe(0);
});
