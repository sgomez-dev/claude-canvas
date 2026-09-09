import { test, expect } from "bun:test";
import React from "react";
import { Image } from "../../src/canvases/image";
import { renderCanvas, settleUntil } from "../harness/render";
import { encode, pattern } from "../harness/png";

/** A base64 PNG, which is how a config carries one inline. */
function png64(width: number, height: number): string {
  return Buffer.from(encode(width, height, 4, pattern(width, height, 4), 0)).toString("base64");
}

// The read is asynchronous even for inline data, so a single settle() lands
// on the "Decoding…" frame. Every test here waits for the condition it is
// about to assert on rather than for a fixed number of macrotasks -- this
// project has hit the same registration/settle race four separate times,
// and twice in tests written during this phase.
const painted = (f: string) => f.includes("▀");

test("an inline PNG renders as half-blocks, scaled to the pane", async () => {
  const r = renderCanvas(<Image id="img-snap" config={{ data: png64(8, 8) }} enabled={false} />, {
    columns: 30,
    rows: 12,
  });
  expect(await settleUntil(r, painted)).toMatchSnapshot();
  r.dispose();
});

test("a title costs one row, and the image gets one fewer", async () => {
  const withTitle = renderCanvas(
    <Image id="img-title" config={{ data: png64(8, 8), title: "Eight by eight" }} enabled={false} />,
    { columns: 30, rows: 12 }
  );
  const titled = await settleUntil(withTitle, painted);
  expect(titled).toContain("Eight by eight");
  expect(titled).toMatchSnapshot();
  withTitle.dispose();

  const plain = renderCanvas(
    <Image id="img-plain" config={{ data: png64(8, 8) }} enabled={false} />,
    { columns: 30, rows: 12 }
  );
  const untitled = await settleUntil(plain, painted);
  plain.dispose();

  // The point of the chrome arithmetic: the title takes its row from the
  // image, not from the pane, so the frame does not grow.
  const rowsOf = (f: string) => f.split("\n").filter((l) => l.includes("▀")).length;
  expect(rowsOf(titled)).toBe(rowsOf(untitled) - 1);
});

// The footer prints the source dimensions, and it is the same string the
// wrap budget measures -- five views here once kept those as two literals.
test("the footer names the source dimensions", async () => {
  const r = renderCanvas(<Image id="img-dims" config={{ data: png64(12, 6) }} enabled={false} />, {
    columns: 40,
    rows: 10,
  });
  expect(await settleUntil(r, painted)).toContain("12×6");
  r.dispose();
});

test("a config error renders instead of an image, and names the field", async () => {
  // 60 columns, not 40: at 40 the message wraps inside the box and no
  // single line contains it, which says nothing about the canvas.
  const r = renderCanvas(<Image id="img-bad" config={{}} enabled={false} />, {
    columns: 60,
    rows: 8,
  });
  const frame = await settleUntil(r, (f) => f.includes("needs a"));
  expect(frame).toContain("image config: needs a 'path' or 'data'");
  expect(frame).not.toContain("▀");
  r.dispose();
});

// A decode failure is not a config failure, and it arrives one tick later.
// It must still reach the same single error frame, naming the source -- an
// "unsupported colour type" with no filename is not actionable.
test("a payload that is not a PNG is reported, naming the source", async () => {
  const r = renderCanvas(
    <Image id="img-notpng" config={{ data: Buffer.from("not a png at all").toString("base64") }} enabled={false} />,
    { columns: 60, rows: 8 }
  );
  const frame = await settleUntil(r, (f) => f.includes("could not read"));
  expect(frame).toContain("inline data");
  expect(frame).toMatch(/not a PNG/i);
  r.dispose();
});

test("a missing file is reported, naming the path", async () => {
  const r = renderCanvas(
    <Image id="img-missing" config={{ path: "/nope/missing.png" }} enabled={false} />,
    { columns: 60, rows: 8 }
  );
  const frame = await settleUntil(r, (f) => f.includes("could not read"));
  expect(frame).toContain("/nope/missing.png");
  r.dispose();
});

// The repository's own screenshot: a real file from a real encoder, 3384x2160,
// which is the path a user actually takes. Asserted rather than snapshotted --
// a 76-column frame of truecolour escapes is not a reviewable baseline.
test("the repository's own screenshot renders from a path", async () => {
  const r = renderCanvas(
    <Image id="img-real" config={{ path: "media/screenshot.png", title: "screenshot" }} enabled={false} />,
    { columns: 80, rows: 26 }
  );
  const frame = await settleUntil(r, painted, 15000);
  expect(frame).toContain("3384×2160");
  // The chrome arithmetic, end to end on a real file: 26 rows minus two
  // borders, a title and a footer leaves exactly 22 for the image. At 76
  // columns the aspect ratio would want 24 rows, so this is the
  // height-bounded branch of fitToCells, and the frame fills the pane
  // exactly rather than overflowing it.
  const imageRows = frame.split("\n").filter((l) => l.includes("▀")).length;
  expect(imageRows).toBe(22);
  expect(frame.split("\n")).toHaveLength(imageRows + 4);
  r.dispose();
});

