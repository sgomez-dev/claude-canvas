import { test, expect } from "bun:test";
import { paintBytes, usesProtocol } from "./paint";
import type { DecodedImage } from "../png";

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const image: DecodedImage = {
  width: 2,
  height: 2,
  pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]),
};
const base = { png, image, columns: 8, rows: 4, originRow: 2, originColumn: 1, imageId: 42 };

test("the tiers with no protocol emit nothing at all", () => {
  for (const tier of ["halfblocks", "none"] as const) {
    expect(paintBytes({ ...base, tier, env: {} as never })).toBe("");
  }
  expect(usesProtocol("halfblocks")).toBe(false);
  expect(usesProtocol("none")).toBe(false);
});

test("each protocol tier emits its own sequence", () => {
  const kitty = paintBytes({ ...base, tier: "kitty", env: {} as never });
  expect(kitty).toContain("\x1b_G");
  expect(kitty).toContain("f=100");

  const iterm = paintBytes({ ...base, tier: "iterm2", env: {} as never });
  expect(iterm).toContain("\x1b]1337;File=");

  const sixel = paintBytes({ ...base, tier: "sixel", env: {} as never });
  expect(sixel).toContain("\x1bP0;1;0q");
});

// Ink believes it knows where the cursor is. Leaving it moved corrupts the
// next frame it draws.
test("the cursor is saved, positioned and restored", () => {
  const out = paintBytes({ ...base, tier: "kitty", originRow: 7, originColumn: 3, env: {} as never });
  expect(out.startsWith("\x1b7")).toBe(true);
  expect(out.endsWith("\x1b8")).toBe(true);
  expect(out).toContain("\x1b[7;3H");
});

// Its placements persist independently of the text grid, so a repaint would
// stack on the previous image rather than replace it. Scoped to this
// canvas's own id (`d=i,i=<id>`), NOT `d=A` ("delete every placement on the
// terminal") -- a second image canvas open alongside this one must not have
// its own placement wiped by this one's repaint.
test("kitty deletes only its own previous placement before drawing, and only kitty", () => {
  expect(paintBytes({ ...base, tier: "kitty", env: {} as never })).toContain("a=d,d=i,i=42");
  expect(paintBytes({ ...base, tier: "kitty", env: {} as never })).not.toContain("d=A");
  expect(paintBytes({ ...base, tier: "iterm2", env: {} as never })).not.toContain("a=d");
  expect(paintBytes({ ...base, tier: "sixel", env: {} as never })).not.toContain("a=d");
});

test("the delete comes before the positioning, not after", () => {
  const out = paintBytes({ ...base, tier: "kitty", env: {} as never });
  expect(out.indexOf("a=d,d=i,i=42")).toBeLessThan(out.indexOf("\x1b[2;1H"));
});

// Two canvases painting side by side must never share an id: one's repaint
// (which clears then redraws its own placement) must not touch the other's.
test("two kitty canvases with different ids never reference each other's placement", () => {
  const left = paintBytes({ ...base, tier: "kitty", imageId: 1, env: {} as never });
  const right = paintBytes({ ...base, tier: "kitty", imageId: 2, env: {} as never });
  expect(left).toContain("i=1");
  expect(left).not.toContain("i=2");
  expect(right).toContain("i=2");
  expect(right).not.toContain("d=i,i=1");
  // Neither ever falls back to the unscoped "delete everything" directive.
  expect(left).not.toContain("d=A");
  expect(right).not.toContain("d=A");
});

// Only the image escape needs wrapping. The cursor moves are ordinary CSI
// that tmux understands and should act on -- wrapping those would send them
// past tmux to the outer terminal, which would move the WRONG cursor.
test("inside tmux the image escape is wrapped and the cursor moves are not", () => {
  const env = { TMUX: "/tmp/x,1,0" } as never;
  const out = paintBytes({ ...base, tier: "iterm2", env });
  expect(out).toContain("\x1bPtmux;");
  // The positioning is still a bare CSI.
  expect(out).toContain("\x1b[2;1H");
  // Save, then position, THEN the wrapped image -- in that order, with the
  // cursor moves outside the DCS where tmux can act on them.
  expect(out.split("\x1bPtmux;")[0]).toBe("\x1b7\x1b[2;1H");
  // And the image escape's own ESCs are doubled inside the DCS.
  expect(out).toContain("\x1b\x1b]1337;File=");
});

test("outside tmux nothing is wrapped", () => {
  const out = paintBytes({ ...base, tier: "iterm2", env: {} as never });
  expect(out).not.toContain("\x1bPtmux;");
  expect(out).toContain("\x1b]1337;File=");
});

test("the cell box reaches the encoder", () => {
  const out = paintBytes({ ...base, tier: "kitty", columns: 61, rows: 19, env: {} as never });
  expect(out).toContain("c=61,r=19");
});

// Sixel resamples to pixels, so the cell assumption is the one input that
// changes its output size rather than just its placement.
test("sixel honours the cell size it is handed", () => {
  const small = paintBytes({
    ...base,
    tier: "sixel",
    columns: 2,
    rows: 1,
    cell: { width: 8, height: 16 },
    env: {} as never,
  });
  const large = paintBytes({
    ...base,
    tier: "sixel",
    columns: 2,
    rows: 1,
    cell: { width: 10, height: 20 },
    env: {} as never,
  });
  expect(small).toContain('"1;1;16;16');
  expect(large).toContain('"1;1;20;20');
});
