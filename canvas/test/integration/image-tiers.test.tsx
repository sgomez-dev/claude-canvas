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

// The default tier for a terminal with no image protocol, and therefore the
// one most people see.
//
// Asserted by CONTRAST rather than by looking for a particular glyph: which
// glyph a quadrant cell picks depends entirely on the image (a horizontally
// split one legitimately renders as ▀ or ▄, since quadrants subsume the
// half-block tier), so naming one would pin an incidental. What must hold is
// that choosing the tier chooses the renderer, and that neither block tier
// emits a protocol escape.
test("the quadrants tier renders block text, and differs from halfblocks", async () => {
  const quad = await mountAt("quadrants", "tier-quad");
  const half = await mountAt("halfblocks", "tier-quad-half");
  const qf = inkFrame(quad);
  const hf = inkFrame(half);
  quad.dispose();
  half.dispose();

  expect(qf).not.toBe("");
  expect(qf).not.toBe(hf);
  for (const frame of [qf, hf]) {
    expect(frame).not.toContain("\x1b_G");
    expect(frame).not.toContain("\x1b]1337");
    expect(frame).not.toContain("\x1bP0;1;0q");
  }
  // Half-blocks have exactly one glyph available; quadrants have sixteen, so
  // the frames can only match when the image happens to need ▀.
  expect(hf).toContain("▀");
  expect(qf).not.toContain("▀");
});

// Detection cannot know which glyphs a font carries, so the default is a
// deliberate choice. Pinned because flipping it is a visible change for
// every user without an image protocol.
//
// TERM and TERM_PROGRAM are set explicitly rather than inherited: this test
// failed on all three CI platforms while passing locally, because
// detectGraphics reads them and CI runners do not have the developer's
// terminal. Environment this test depends on is environment this test has
// to state -- the same lesson as TZ, colour and locale in test/setup.ts.
test("with no override, a plain terminal detects quadrants", async () => {
  const saved = {
    graphics: process.env.CANVAS_GRAPHICS,
    term: process.env.TERM,
    program: process.env.TERM_PROGRAM,
  };
  try {
    delete process.env.CANVAS_GRAPHICS;
    process.env.TERM = "xterm-256color";
    process.env.TERM_PROGRAM = "Apple_Terminal";

    const auto = renderCanvas(<Image id="tier-default" config={CONFIG} enabled={false} />, {
      columns: 40,
      rows: 12,
    });
    await settleUntil(auto, (f) => f.includes("Tiered"));
    const autoFrame = inkFrame(auto);
    auto.dispose();

    process.env.CANVAS_GRAPHICS = "quadrants";
    const forced = renderCanvas(<Image id="tier-forced" config={CONFIG} enabled={false} />, {
      columns: 40,
      rows: 12,
    });
    await settleUntil(forced, (f) => f.includes("Tiered"));
    const forcedFrame = inkFrame(forced);
    forced.dispose();

    expect(autoFrame).not.toBe("");
    expect(autoFrame).toBe(forcedFrame);
  } finally {
    if (saved.graphics === undefined) delete process.env.CANVAS_GRAPHICS;
    else process.env.CANVAS_GRAPHICS = saved.graphics;
    if (saved.term === undefined) delete process.env.TERM;
    else process.env.TERM = saved.term;
    if (saved.program === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.program;
  }
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

/** Extracts every kitty control block (the part before `;<payload>`) from a stream. */
function kittyControls(s: string): string[] {
  const out: string[] = [];
  const re = /\x1b_G([^;]*);/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) out.push(m[1]!);
  return out;
}

// Two `image` canvases open side by side (a supported flow -- two dashboard
// panes each showing a different picture) each get their own kitty image id,
// and a repaint on one must delete only that canvas's own placement, never
// the OTHER canvas's, and never kitty's "delete everything on the terminal"
// directive (`d=A`). Before this fix, `KITTY_CLEAR` was a single unscoped
// `a=d,d=A` constant shared by every instance, so canvas A repainting on its
// own state change would wipe canvas B's image too.
test("two kitty canvases open at once never delete each other's placement", async () => {
  const idA = "tier-kitty-a";
  const idB = "tier-kitty-b";
  process.env.CANVAS_GRAPHICS = "kitty";
  const a = renderCanvas(<Image id={idA} config={{ data: png64(8, 8) }} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  const b = renderCanvas(<Image id={idB} config={{ data: png64(8, 8) }} enabled={true} />, {
    columns: 40,
    rows: 12,
  });
  try {
    await a.settle();
    await b.settle();
    expect(await awaitRecord(idA, 5000)).not.toBeNull();
    expect(await awaitRecord(idB, 5000)).not.toBeNull();
    await settleUntil(a, () => a.frames.join("").includes("\x1b_G"));
    await settleUntil(b, () => b.frames.join("").includes("\x1b_G"));

    const idsA = kittyControls(a.frames.join(""))
      .map((c) => /(?:^|,)i=(\d+)/.exec(c)?.[1])
      .filter((x): x is string => x !== undefined);
    const idsB = kittyControls(b.frames.join(""))
      .map((c) => /(?:^|,)i=(\d+)/.exec(c)?.[1])
      .filter((x): x is string => x !== undefined);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    // Each canvas is internally consistent about its own id...
    expect(new Set(idsA).size).toBe(1);
    expect(new Set(idsB).size).toBe(1);
    // ...and the two canvases never share one.
    expect(idsA[0]).not.toBe(idsB[0]);

    // Repaint A (a pushed config triggers the same clear-then-redraw a
    // state-driven repaint does) and confirm its clear references only its
    // own id -- never B's id, and never the unscoped "delete all".
    await pushUpdate(idA, { data: png64(20, 10) });
    await settleUntil(a, () => a.frames.join("").includes("20×10"));
    for (let i = 0; i < 5; i++) await a.settle();

    const aStream = a.frames.join("");
    expect(aStream).toContain(`a=d,d=i,i=${idsA[0]}`);
    expect(aStream).not.toContain(`i=${idsB[0]}`);
    expect(aStream).not.toContain("d=A");
  } finally {
    a.dispose();
    b.dispose();
    await deleteRecord(idA);
    await deleteRecord(idB);
  }
});
