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
  // Incoming bytes are held as a LIST of chunks, not one growing buffer.
  //
  // The previous implementation allocated a new buffer sized to everything
  // received so far and copied the prior contents into it on every push,
  // then copied the remainder again on frame completion. That is O(n^2) in
  // the number of chunks: the roadmap recorded it as deferred debt and
  // estimated ~2 GB of copying for a 16 MB frame arriving in 64 KB pieces.
  //
  // Measured before this rewrite, on a 4 MB frame: 39 ms in 16 KB chunks,
  // 15 ms in 64 KB chunks, 7 ms in 256 KB chunks -- so the real cost was an
  // order of magnitude below that estimate, but it still grew with the
  // square of the chunk count, and Phase 3's screenshots are exactly the
  // payloads that meet it. Now every byte is copied once on arrival and at
  // most once more when its frame completes: O(n) either way.
  private chunks: Uint8Array[] = [];
  private pending = 0;

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      // Copied rather than retained by reference. Bun hands `data` to a
      // socket handler as a view whose lifetime it owns, so keeping the
      // view and decoding it later could read bytes the runtime has since
      // reused. The previous implementation copied here too (into its
      // merged buffer), so this is not a new cost -- what changed is that
      // it no longer also re-copies everything received before it.
      this.chunks.push(new Uint8Array(chunk));
      this.pending += chunk.byteLength;
    }

    const out: unknown[] = [];
    for (;;) {
      if (this.pending < 4) break;
      const len = this.peekLength();
      // Checked before allocating, so a hostile length prefix cannot make
      // us reserve unbounded memory. Note `>`: a frame of exactly
      // MAX_FRAME_BYTES is legal and must wait for its body, not throw.
      if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
      if (this.pending < 4 + len) break;
      out.push(JSON.parse(new TextDecoder().decode(this.takeBody(len))));
    }
    return out;
  }

  /**
   * Reads the 4-byte big-endian length prefix without consuming it. Walks
   * byte by byte because the prefix can straddle a chunk boundary -- a
   * socket is free to deliver those four bytes in four separate events.
   * Multiplication rather than `<<` so a length above 2^31 stays positive.
   */
  private peekLength(): number {
    let value = 0;
    let seen = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.byteLength && seen < 4; i++, seen++) {
        value = value * 256 + chunk[i]!;
      }
      if (seen === 4) break;
    }
    return value;
  }

  /**
   * Consumes the 4-byte prefix plus `len` body bytes and returns just the
   * body.
   */
  private takeBody(len: number): Uint8Array {
    const total = 4 + len;
    const head = this.chunks[0]!;

    // Fast path: the whole frame is already contiguous in the head chunk,
    // which is the common case for the small frames this protocol carries.
    // subarray is a view, so this copies nothing at all.
    if (head.byteLength >= total) {
      const body = head.subarray(4, total);
      if (head.byteLength === total) this.chunks.shift();
      else this.chunks[0] = head.subarray(total);
      this.pending -= total;
      return body;
    }

    // Slow path: the frame spans chunks, so join exactly this frame's bytes
    // once. Deliberately not joining the whole backlog -- a second frame
    // sitting behind this one stays unjoined until it is itself complete.
    const joined = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      const c = this.chunks[0]!;
      const need = total - offset;
      if (c.byteLength <= need) {
        joined.set(c, offset);
        offset += c.byteLength;
        this.chunks.shift();
      } else {
        joined.set(c.subarray(0, need), offset);
        this.chunks[0] = c.subarray(need);
        offset = total;
      }
    }
    this.pending -= total;
    return joined.subarray(4);
  }
}

export type ControllerMessage =
  | { type: "hello"; token: string }
  | { type: "update"; config: unknown }
  | { type: "get"; key: string }
  | { type: "close" }
  | { type: "ping" };

/**
 * The subset of CanvasMessage that ends a canvas's interaction. Exactly one
 * of these is ever produced, and it is the thing a controller's `wait` is
 * waiting for -- so it is also the thing that has to survive the canvas
 * exiting, which is why it has its own name and gets persisted into the
 * registry record.
 */
export type OutcomeMessage =
  | { type: "selected"; data: unknown }
  | { type: "cancelled"; reason?: string }
  | { type: "error"; message: string };

export type CanvasMessage =
  | { type: "hello-ok" }
  | { type: "error"; message: string }
  | { type: "ready"; scenario: string; capabilities: unknown }
  | { type: "value"; key: string; data: unknown }
  | { type: "selected"; data: unknown }
  | { type: "cancelled"; reason?: string }
  | { type: "pong" };
