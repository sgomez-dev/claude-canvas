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
