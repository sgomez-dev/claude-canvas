import { test, expect } from "bun:test";
import { encodeFrame, FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from "./protocol";

test("roundtrips one frame", () => {
  const d = new FrameDecoder();
  expect(d.push(encodeFrame({ type: "ping" }))).toEqual([{ type: "ping" }]);
});

test("reassembles a frame split across three chunks", () => {
  const buf = encodeFrame({ type: "selected", data: { a: 1 } });
  const d = new FrameDecoder();
  expect(d.push(buf.slice(0, 2))).toEqual([]);
  expect(d.push(buf.slice(2, 7))).toEqual([]);
  expect(d.push(buf.slice(7))).toEqual([{ type: "selected", data: { a: 1 } }]);
});

test("returns several frames arriving in one chunk", () => {
  const a = encodeFrame({ type: "ping" });
  const b = encodeFrame({ type: "pong" });
  const both = new Uint8Array(a.length + b.length);
  both.set(a, 0);
  both.set(b, a.length);
  expect(new FrameDecoder().push(both)).toEqual([{ type: "ping" }, { type: "pong" }]);
});

test("survives a payload containing newlines", () => {
  // The old newline-delimited protocol broke on exactly this.
  const msg = { type: "update", config: { content: "line1\nline2\n" } };
  expect(new FrameDecoder().push(encodeFrame(msg))).toEqual([msg]);
});

test("rejects a frame declaring more than the ceiling", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
  expect(() => new FrameDecoder().push(header)).toThrow(FrameTooLargeError);
});

test("refuses to encode an oversized payload", () => {
  expect(() => encodeFrame({ type: "update", config: "x".repeat(MAX_FRAME_BYTES) }))
    .toThrow(FrameTooLargeError);
});

test("throws on malformed JSON inside a well-formed frame", () => {
  const body = new TextEncoder().encode("{not json");
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  expect(() => new FrameDecoder().push(frame)).toThrow();
});

test("handles a zero-length chunk", () => {
  expect(new FrameDecoder().push(new Uint8Array(0))).toEqual([]);
});

test("complete frame plus partial next, completed on a later push", () => {
  const d = new FrameDecoder();
  const frame1 = encodeFrame({ type: "ping" });
  const frame2 = encodeFrame({ type: "pong" });
  const combined = new Uint8Array(frame1.length + frame2.length);
  combined.set(frame1, 0);
  combined.set(frame2, frame1.length);

  // Push first frame in full plus first 2 bytes of second frame
  const partial = combined.slice(0, frame1.length + 2);
  expect(d.push(partial)).toEqual([{ type: "ping" }]);

  // Push remaining bytes of second frame
  expect(d.push(combined.slice(frame1.length + 2))).toEqual([{ type: "pong" }]);
});

test("zero-length declared body throws on JSON.parse", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, 0, false);
  expect(() => new FrameDecoder().push(header)).toThrow();
});

test("frame of exactly MAX_FRAME_BYTES is accepted, not rejected", () => {
  const d = new FrameDecoder();
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES, false);
  // Should not throw on the header alone; should wait for more bytes
  expect(d.push(header)).toEqual([]);
});

// The 4-byte length prefix can straddle a chunk boundary: a socket is free
// to deliver those four bytes in four separate events. The decoder now
// reads the prefix byte by byte across chunks rather than assuming the
// first chunk holds all of it.
test("reassembles a frame whose length prefix arrives one byte per chunk", () => {
  const buf = encodeFrame({ type: "selected", data: { a: 1 } });
  const d = new FrameDecoder();
  for (let i = 0; i < 4; i++) expect(d.push(buf.slice(i, i + 1))).toEqual([]);
  expect(d.push(buf.slice(4))).toEqual([{ type: "selected", data: { a: 1 } }]);
});

test("decodes a multi-frame stream delivered one byte at a time", () => {
  const a = encodeFrame({ type: "ping" });
  const b = encodeFrame({ type: "update", config: { n: 2 } });
  const stream = new Uint8Array(a.length + b.length);
  stream.set(a, 0);
  stream.set(b, a.length);

  const d = new FrameDecoder();
  const got: unknown[] = [];
  for (let i = 0; i < stream.length; i++) got.push(...d.push(stream.slice(i, i + 1)));
  expect(got).toEqual([{ type: "ping" }, { type: "update", config: { n: 2 } }]);
});

// The chunk-list rewrite must not join the whole backlog when one frame
// completes: a frame still arriving behind a completed one has to stay
// buffered untouched.
test("a completed frame is returned while the next one is still arriving", () => {
  const a = encodeFrame({ type: "ping" });
  const b = encodeFrame({ type: "pong" });
  const d = new FrameDecoder();
  expect(d.push(a)).toEqual([{ type: "ping" }]);
  expect(d.push(b.slice(0, 3))).toEqual([]);
  expect(d.push(b.slice(3, 5))).toEqual([]);
  expect(d.push(b.slice(5))).toEqual([{ type: "pong" }]);
});

test("a large frame survives arriving in many small chunks intact", () => {
  // 2 MB of distinguishable content in 4 KB pieces: 500+ chunks, which is
  // the shape that used to cost a re-copy of the whole backlog per push.
  const payload = Array.from({ length: 40_000 }, (_, i) => `row-${i}`).join("\n");
  const buf = encodeFrame({ type: "update", config: { payload } });
  const d = new FrameDecoder();
  const got: unknown[] = [];
  for (let off = 0; off < buf.byteLength; off += 4096) {
    got.push(...d.push(buf.slice(off, Math.min(off + 4096, buf.byteLength))));
  }
  expect(got).toHaveLength(1);
  expect((got[0] as { config: { payload: string } }).config.payload).toBe(payload);
});
