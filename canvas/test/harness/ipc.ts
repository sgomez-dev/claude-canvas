import type { CanvasMessage } from "../../src/runtime/protocol";
import type { Connection } from "../../src/runtime/client";

/**
 * Reads frames off a controller connection until a terminal outcome
 * arrives, skipping everything that is not one.
 *
 * A controller must not assume the first frame it receives is its outcome.
 * On authenticating it is now sent the retained `ready` message, and then
 * any outcome the canvas has already produced -- so `ready` legitimately
 * arrives first. This mirrors what waitForOutcome does in production; the
 * tests that used to call conn.next() once and assert on the result were
 * relying on `ready` being unobservable, which it no longer is.
 */
export async function nextOutcome(
  conn: Connection,
  timeoutMs = 2000
): Promise<CanvasMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const msg = await conn.next(remaining);
    if (msg === null) return null;
    if (msg.type === "selected" || msg.type === "cancelled" || msg.type === "error") return msg;
  }
}

/**
 * Re-renders until `predicate` holds on the latest frame, or the deadline
 * passes, and returns that frame.
 *
 * A single `settle()` waits one macrotask, which is enough for a state
 * change already committed in-process and NOT enough for anything that has
 * to cross a socket first. `pushUpdate` resolves once the bytes are handed
 * to the socket; the canvas still has to receive them, decode them and
 * re-render. A 600 KB config needs many event-loop turns to do that, and
 * asserting after one macrotask passes only when the machine is idle --
 * which is why `a large config survives the update path` passed locally 30+
 * times and failed on ubuntu-latest in CI run for 27f8af2.
 */
export async function settleUntil(
  r: { settle(): Promise<string> },
  predicate: (frame: string) => boolean,
  timeoutMs = 5000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = await r.settle();
  while (!predicate(frame) && Date.now() < deadline) {
    frame = await r.settle();
  }
  return frame;
}
