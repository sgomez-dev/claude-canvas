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
