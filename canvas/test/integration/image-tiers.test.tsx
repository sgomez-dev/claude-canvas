import { test, expect, afterEach } from "bun:test";
import React from "react";
import { Image } from "../../src/canvases/image";
import { renderCanvas, settleUntil } from "../harness/render";
import { encode, pattern } from "../harness/png";
import { awaitRecord, deleteRecord } from "../../src/runtime/registry";
import { pushUpdate } from "../../src/runtime/client";

// The suite pins CANVAS_GRAPHICS=halfblocks (see test/setup.ts) so snapshots
// are stable whatever terminal a developer runs. These tests each choose a
// tier and put it back, so one leaking would not silently retier the rest.
const PINNED = process.env.CANVAS_GRAPHICS;
afterEach(() => {
  process.env.CANVAS_GRAPHICS = PINNED;
});

function png64(width: number, height: number): string {
  return Buffer.from(encode(width, height, 4, pattern(width, height, 4), 0)).toString("base64");
}

const CONFIG = { data: png64(16, 16), title: "Tiered" };

/**
 * The last frame Ink itself drew.
 *
 * A protocol tier writes its escape to the SAME stdout, from a passive
 * effect after the frame -- so the harness's last "frame" is the escape, not
 * the rendered text. Picking the last frame carrying the footer is what
 * separates what Ink laid out from what was painted over it.
 */
function inkFrame(r: { frames: string[] }): string {
  return [...r.frames].reverse().find((f) => f.includes("Esc: close")) ?? "";
}

async function mountAt(tier: string, id: string) {
  process.env.CANVAS_GRAPHICS = tier;
  const r = renderCanvas(<Image id={id} config={CONFIG} enabled={false} />, {
    columns: 40,
    rows: 12,
  });
  // The protocol tiers write their escape from a passive effect after the
  // frame, so wait for the bytes rather than for a fixed number of ticks.
  await settleUntil(r, () => r.frames.join("").includes("Tiered"));
  for (let i = 0; i < 5; i++) await r.settle();
  return r;
}

test("the kitty tier emits a kitty escape and reserves rows for it", async () => {
  const r = await mountAt("kitty", "tier-kitty");
  const all = r.frames.join("");
  expect(all).toContain("\x1b_G");
  expect(all).toContain("f=100");
  expect(all).toContain("a=T");
  // Positioned under the title, at column one.
  expect(all).toContain("\x1b[2;1H");
  // And NOT painted as half-blocks: that is the whole point of the tier.
  expect(inkFrame(r)).not.toContain("▀");
  expect(inkFrame(r)).toContain("kitty");
  r.dispose();
});

test("the iterm2 tier emits an inline-image OSC", async () => {
  const r = await mountAt("iterm2", "tier-iterm");
  const all = r.frames.join("");
  expect(all).toContain("\x1b]1337;File=");
  expect(all).toContain("inline=1");
  expect(inkFrame(r)).not.toContain("▀");
  r.dispose();
});

test("the sixel tier emits a sixel DCS with raster attributes", async () => {
  const r = await mountAt("sixel", "tier-sixel");
  const all = r.frames.join("");
  expect(all).toContain("\x1bP0;1;0q");
  expect(all).toMatch(/"1;1;\d+;\d+/);
  expect(inkFrame(r)).not.toContain("▀");
  r.dispose();
});

// The baseline tier must emit no protocol escape at all. A stray one would
// print as garbage in Apple Terminal, which is the most common host.
test("the halfblocks tier emits no protocol escape whatsoever", async () => {
  const r = await mountAt("halfblocks", "tier-half");
  const all = r.frames.join("");
  expect(all).not.toContain("\x1b_G");
  expect(all).not.toContain("\x1b]1337");
  expect(all).not.toContain("\x1bP0;1;0q");
  expect(inkFrame(r)).toContain("▀");
  r.dispose();
});

// A misspelled override is reported through the canvas's single error
// channel rather than throwing mid-render, which would take the pane down
// with no message at all.
test("a misspelled graphics override is reported, not a crash", async () => {
  process.env.CANVAS_GRAPHICS = "sixl";
  const r = renderCanvas(<Image id="tier-bad" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 10,
  });
  const frame = await settleUntil(r, (f) => f.includes("Invalid"));
  expect(frame).toContain("Invalid CANVAS_GRAPHICS");
  expect(frame).toContain("sixl");
  r.dispose();
});

test("a misspelled cell override is reported the same way", async () => {
  process.env.CANVAS_GRAPHICS = "sixel";
  process.env.CANVAS_CELL_PIXELS = "10by20";
  const r = renderCanvas(<Image id="tier-badcell" config={CONFIG} enabled={false} />, {
    columns: 60,
    rows: 10,
  });
  const frame = await settleUntil(r, (f) => f.includes("Invalid"));
  expect(frame).toContain("Invalid CANVAS_CELL_PIXELS");
  delete process.env.CANVAS_CELL_PIXELS;
  r.dispose();
});

// The repaint effect carries no dependency array on purpose: Ink redraws its
// whole frame on every commit, and for iTerm2 and Sixel that redraw erases
// an image drawn into the text grid. A pushed config is the observable case
// -- the second image must be emitted, not just laid out.
test("a pushed config repaints the protocol image", async () => {
  const id = "tier-repaint";
  process.env.CANVAS_GRAPHICS = "iterm2";
  const r = renderCanvas(<Image id={id} config={{ data: png64(8, 8) }} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  try {
    await r.settle();
    expect(await awaitRecord(id, 5000)).not.toBeNull();
    await settleUntil(r, () => r.frames.join("").includes("\x1b]1337;File="));
    const before = r.frames.filter((f) => f.includes("\x1b]1337;File=")).length;
    expect(before).toBeGreaterThan(0);

    await pushUpdate(id, { data: png64(20, 10) });
    await settleUntil(r, () => r.frames.join("").includes("20×10"));
    for (let i = 0; i < 5; i++) await r.settle();

    const after = r.frames.filter((f) => f.includes("\x1b]1337;File=")).length;
    expect(after).toBeGreaterThan(before);
  } finally {
    r.dispose();
    await deleteRecord(id);
  }
});
