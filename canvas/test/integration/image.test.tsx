import { test, expect, afterEach, afterAll, mock } from "bun:test";
import React from "react";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Image } from "../../src/canvases/image";
import { renderCanvas } from "../harness/render";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { openConnection, pushUpdate } from "../../src/runtime/client";
import { nextOutcome, settleUntil } from "../harness/ipc";
import { encode, pattern } from "../harness/png";
import * as realPng from "../../src/canvases/png";

const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0)) await deleteRecord(id);
});

// Wraps the real decodePng so the race test below can see whether it was
// ever CALLED for a superseded read's bytes, not just whether its result
// ever reached the screen -- the two are different claims, and the
// pre-existing test only ever checked the second. `...realPng` keeps every
// other export (and decodePng's own real behavior, via delegation) intact,
// so every other test in this file still sees a fully working decoder.
//
// The real function is captured into a plain local BEFORE `mock.module`
// runs, not read back through `realPng.decodePng` inside the wrapper: the
// `realPng` namespace import is a LIVE binding, so once the module is
// mocked, `realPng.decodePng` resolves to the wrapper itself -- calling it
// from inside its own body recurses forever (reproduced directly: every
// call logged, in an unbroken loop, until the process was killed).
// `originalDecodePng` is a plain variable, not a live binding, so it keeps
// pointing at the pre-mock function regardless of what the module record
// is later overridden to.
const originalDecodePng = realPng.decodePng;

// `mock.module` has no direct "unmock"; `bun test` runs every matched file
// in one process, so leaving this override in place would leak the
// call-tracking wrapper into whichever test file happens to run next. The
// `afterAll` below re-mocks with the untouched `realPng` reference captured
// above, restoring the original behavior for the rest of the run.
let decodePngCalls: Uint8Array[] = [];
mock.module("../../src/canvases/png", () => ({
  ...realPng,
  decodePng: (bytes: Uint8Array) => {
    decodePngCalls.push(bytes);
    return originalDecodePng(bytes);
  },
}));
afterAll(() => {
  mock.module("../../src/canvases/png", () => realPng);
});

function png64(width: number, height: number): string {
  return Buffer.from(encode(width, height, 4, pattern(width, height, 4), 0)).toString("base64");
}

const painted = (f: string) => f.includes("▀");
const ESC = "\x1b";

async function mount(node: React.ReactElement, id: string) {
  ids.push(id);
  const r = renderCanvas(node, { columns: 40, rows: 12 });
  await r.settle();
  // `spawn` waits for the record rather than for the pane, and so does this:
  // the server starts asynchronously, so connecting before the record exists
  // is a race, not a failure.
  expect(await awaitRecord(id, 5000)).not.toBeNull();
  return r;
}

// Every canvas must run a server when enabled. A canvas without one writes
// no registry record, so it cannot be listed, read or closed -- `close`
// answers "no canvas <id>" for a pane sitting right there. The calendar's
// display scenario was missing exactly this.
test("the canvas is reachable over a real socket and reports a record", async () => {
  const id = "ipc-image-record";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  const record = await awaitRecord(id, 5000);
  expect(record?.kind).toBe("image");
  expect(record?.scenario).toBe("display");
  r.dispose();
});

test("Escape produces a cancelled outcome, over the socket", async () => {
  const id = "ipc-image-escape";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  await settleUntil(r, painted);

  const conn = await openConnection(id);
  r.stdin.write(ESC);
  const outcome = await nextOutcome(conn);
  expect(outcome).toEqual({ type: "cancelled", reason: "escape" });
  conn.close();
  r.dispose();
});

// A pushed config is a new image. `ImageView` carries no state of its own --
// the image itself lives in the shell, and the load effect replaces it -- so
// there is no generation counter to remount on; see the "Carries no
// `generation` counter" note on the `Image` component for why.
test("a pushed config replaces the image", async () => {
  const id = "ipc-image-update";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  expect(await settleUntil(r, (f) => f.includes("8×8"))).toContain("8×8");

  await pushUpdate(id, { data: png64(20, 10), title: "pushed" });
  const frame = await settleUntil(r, (f) => f.includes("20×10"));
  expect(frame).toContain("pushed");
  expect(frame).toContain("▀");
  r.dispose();
});

// The decode happens in the shell, one tick after the config arrives, so a
// pushed config that fails must reach the controller the same way a
// malformed one does -- through the single error channel, not as a silent
// blank frame.
test("a pushed payload that is not a PNG is reported as an error", async () => {
  const id = "ipc-image-bad-push";
  const r = await mount(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, id);
  await settleUntil(r, painted);

  const conn = await openConnection(id);
  await pushUpdate(id, { data: Buffer.from("still not a png").toString("base64") });
  const outcome = await nextOutcome(conn);
  expect(outcome?.type).toBe("error");
  expect((outcome as { message: string }).message).toMatch(/could not read inline data.*not a PNG/i);
  conn.close();
  r.dispose();
});

// Pins what actually happens, which is not what I assumed when writing this
// canvas: a config error is a TERMINAL outcome, so the first one is the only
// one the canvas will ever produce. useCanvasServer's emitOutcome returns
// early once an outcome exists, by design -- "a controller can never read
// one of two contradictory answers" -- and the retained outcome is replayed
// to every controller that authenticates later. So a second bad config
// reports nothing new, and a controller connecting afterwards is handed the
// FIRST error, not the current state.
//
// Worth knowing before writing a controller that pushes configs in a loop:
// once one is rejected, the canvas has spent its single answer.
test("a config error is terminal: the second bad config reports nothing new", async () => {
  const id = "ipc-image-two-errors";
  const r = await mount(<Image id={id} config={{}} enabled={true} />, id);

  const conn = await openConnection(id);
  const first = await nextOutcome(conn);
  expect(first?.type).toBe("error");
  expect((first as { message: string }).message).toBe("image config: needs a 'path' or 'data'");

  // A different problem, pushed onto the same canvas.
  await pushUpdate(id, { path: "b.png", data: "abc" });
  // Nothing further arrives on the connection that already has the outcome.
  expect(await nextOutcome(conn, 300)).toBeNull();
  conn.close();

  // And a controller attaching now is replayed the first error, not the
  // second problem -- which the frame on screen does show.
  const later = await openConnection(id);
  const replayed = await nextOutcome(later);
  expect((replayed as { message: string }).message).toBe(
    "image config: needs a 'path' or 'data'"
  );
  later.close();
  expect(await r.settle()).toContain("not both");
  r.dispose();
});

test("a malformed config is reported over the socket, not just rendered", async () => {
  const id = "ipc-image-bad-config";
  const r = await mount(<Image id={id} config={{ path: "a.png", data: "abc" }} enabled={true} />, id);
  const conn = await openConnection(id);
  const outcome = await nextOutcome(conn);
  expect(outcome?.type).toBe("error");
  expect((outcome as { message: string }).message).toBe(
    "image config: give either 'path' or 'data', not both"
  );
  conn.close();
  r.dispose();
});

// The stale-read race, made real rather than theoretical. A `path` source's
// read is a genuine async yield point (`await Bun.file(...).bytes()`), so a
// config pushed while a large image is still being read starts a SECOND
// load while the first is still in flight -- both racing to decide what
// finally renders. This was previously asserted to be "structurally
// untestable" on the (incorrect) theory that `decodePng`'s synchronicity
// closed the window; the actual yield point is the read above, not the
// decode, and pushing a second, smaller config during a large image's read
// reproduces the race directly, as below.
// A larger timeout than this file's other tests: disposing a canvas that
// persisted a config via a real file interacts with writeRecordSync's own
// Windows EPERM retry budget (registry.ts's SYNC_RETRY_DELAYS_MS, up to
// ~3.2s) when the OS briefly holds a registry file open -- documented there
// as routine under antivirus/indexer contention, not something this test's
// race triggers on its own.
test("a config pushed while a large image is still loading does not lose to a stale, late-arriving read", async () => {
  // Real, incompressible pixel data: a deterministic pattern compresses away
  // to almost nothing, which would make the read too fast to race against.
  // 500x400 is small enough to keep this test fast and light on memory while
  // still forcing a real disk read with a genuine, if brief, async gap.
  const width = 500;
  const height = 400;
  const bigBytes = encode(width, height, 4, randomBytes(width * height * 4), 0);
  const bigPath = join(tmpdir(), `image-race-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await Bun.write(bigPath, bigBytes);

  const id = "ipc-image-race-" + Date.now();
  try {
    const r = await mount(<Image id={id} config={{ path: bigPath }} enabled={true} />, id);

    // Pushed immediately, while the big image's read is presumably still in
    // flight -- not after waiting for it to settle.
    await pushUpdate(id, { data: png64(20, 10), title: "the final answer" });

    const frame = await settleUntil(r, (f) => f.includes("20×10"), 5000);
    expect(frame).toContain("20×10");
    expect(frame).toContain("the final answer");
    // Never a trace of the superseded large image's own dimensions.
    expect(frame).not.toContain(`${width}×${height}`);
    r.dispose();
  } finally {
    await Bun.file(bigPath).delete?.().catch(() => {});
  }
}, 15000);

// The regression test above only ever asserted on the FINAL rendered frame.
// That is not evidence the `cancelled` check runs before `decodePng` --
// image.tsx's `if (!cancelled) { setPng(...); setImage(...); }` guard
// (present even before that check was moved earlier) is already sufficient
// to keep a stale decode's RESULT off screen, regardless of whether the
// decode itself ran. Reverting just the ordering fix (moving `cancelled`
// back to run only after `decodePng`, leaving everything else as-is) and
// running the whole suite produces zero failures -- confirmed directly
// against this codebase, not assumed -- because nothing before this test
// checked whether the expensive decode was actually skipped, only whether
// its output was.
//
// This test checks the thing that actually matters: that a superseded
// read's bytes never reach `decodePng` at all, not merely that they are
// discarded after it. It uses the `decodePng` wrapper installed by
// `mock.module` above, which records every call's bytes while still
// delegating to the real decoder so the canvas renders normally.
test("a superseded read's bytes never reach decodePng, not merely its result", async () => {
  decodePngCalls = [];

  const width = 500;
  const height = 400;
  const bigBytes = encode(width, height, 4, randomBytes(width * height * 4), 0);
  const bigPath = join(tmpdir(), `image-decode-race-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await Bun.write(bigPath, bigBytes);
  const smallBytes = encode(20, 10, 4, pattern(20, 10, 4), 0);

  // The pre-existing race test above only "presumably" catches the read
  // still in flight (its own comment hedges this) -- whether it actually
  // does depends on this file's real disk-read latency outracing
  // `pushUpdate`'s real IPC round-trip, which is exactly the kind of
  // environment-dependent timing this project's CLAUDE.md warns against
  // trusting ("flaky failures vary, deterministic bugs don't"). That test
  // only needs the FINAL frame to be right, so the race being lopsided
  // doesn't hurt it -- but this test needs to know whether `decodePng` was
  // ever called for the superseded bytes, which the outcome depends on
  // entirely. So `Bun.file` is patched here, for this one test only, to add
  // a deterministic delay before THIS path's `.bytes()` resolves -- long
  // enough that `pushUpdate`'s round-trip (and the resulting cleanup/
  // cancellation) reliably completes first, regardless of host disk speed.
  const realBunFile = Bun.file;
  (Bun as unknown as { file: typeof Bun.file }).file = ((path: Parameters<typeof Bun.file>[0], opts?: Parameters<typeof Bun.file>[1]) => {
    const ref = realBunFile(path, opts);
    if (typeof path !== "string" || path !== bigPath) return ref;
    return {
      ...ref,
      bytes: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ref.bytes();
      },
    } as ReturnType<typeof Bun.file>;
  }) as typeof Bun.file;

  const id = "ipc-image-decode-race-" + Date.now();
  try {
    const r = await mount(<Image id={id} config={{ path: bigPath }} enabled={true} />, id);

    // Pushed immediately, well before the artificially delayed read above
    // resolves.
    await pushUpdate(id, { data: Buffer.from(smallBytes).toString("base64"), title: "the final answer" });

    const frame = await settleUntil(r, (f) => f.includes("20×10"), 5000);
    expect(frame).toContain("20×10");
    r.dispose();

    // Give the delayed big-image read time to resolve and reach (or, once
    // fixed, be skipped before reaching) decodePng, so a regression here
    // isn't hidden by the assertions below running too early.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // decodePng must have run for the small (superseding) image's bytes --
    // the canvas visibly rendered it, so it obviously decoded it -- and
    // must NEVER have run for the big (superseded) image's bytes, which is
    // the actual claim the ordering fix makes and the prior test never
    // checked.
    const decodedBig = decodePngCalls.some((b) => b.length === bigBytes.length);
    expect(decodedBig).toBe(false);
    expect(decodePngCalls.length).toBeGreaterThanOrEqual(1);
    expect(decodePngCalls.every((b) => b.length === smallBytes.length)).toBe(true);
  } finally {
    (Bun as unknown as { file: typeof Bun.file }).file = realBunFile;
    await Bun.file(bigPath).delete?.().catch(() => {});
  }
}, 15000);
