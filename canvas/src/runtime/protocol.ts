export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  constructor(size: number) {
    super(`Frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte ceiling`);
    this.name = "FrameTooLargeError";
  }
}

export function encodeFrame(msg: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  if (body.byteLength > MAX_FRAME_BYTES) throw new FrameTooLargeError(body.byteLength);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, false);
  out.set(body, 4);
  return out;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.byteLength);
      this.buf = merged;
    }

    const out: unknown[] = [];
    for (;;) {
      if (this.buf.byteLength < 4) break;
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength
      ).getUint32(0, false);
      // Checked before allocating, so a hostile length prefix cannot make us
      // reserve unbounded memory.
      if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
      if (this.buf.byteLength < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      out.push(JSON.parse(new TextDecoder().decode(body)));
      this.buf = this.buf.slice(4 + len);
    }
    return out;
  }
}

export type ControllerMessage =
  | { type: "hello"; token: string }
  | { type: "update"; config: unknown }
  | { type: "get"; key: string }
  | { type: "close" }
  | { type: "ping" };

export type CanvasMessage =
  | { type: "hello-ok" }
  | { type: "error"; message: string }
  | { type: "ready"; scenario: string; capabilities: unknown }
  | { type: "value"; key: string; data: unknown }
  | { type: "selected"; data: unknown }
  | { type: "cancelled"; reason?: string }
  | { type: "pong" };
