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
