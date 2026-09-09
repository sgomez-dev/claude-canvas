import { test, expect } from "bun:test";
import { encodeITerm2 } from "./iterm2";

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function parse(s: string): { args: string; payload: string } {
  const m = /^\x1b\]1337;File=([^:]*):(.*)\x07$/.exec(s);
  if (m === null) throw new Error(`not an iTerm2 inline image: ${JSON.stringify(s)}`);
  return { args: m[1]!, payload: m[2]! };
}

test("a PNG becomes one OSC 1337 sequence, BEL-terminated", () => {
  const parts = encodeITerm2(png, { columns: 10, rows: 5 });
  expect(parts).toHaveLength(1);
  const { args, payload } = parse(parts[0]!);
  expect(args).toBe("inline=1;size=7;width=10;height=5;preserveAspectRatio=1");
  expect(Buffer.from(payload, "base64")).toEqual(Buffer.from(png));
});

// A bare number means CELLS to iTerm2; `10px` would mean ten pixels and
// `10%` a tenth of the pane. The caller computed cells, so cells is what
// must be sent -- a unit slip here shrinks every image to a sliver.
test("width and height are bare numbers, so iTerm2 reads them as cells", () => {
  const { args } = parse(encodeITerm2(png, { columns: 76, rows: 22 })[0]!);
  expect(args).toContain("width=76;height=22");
  expect(args).not.toContain("px");
  expect(args).not.toContain("%");
});

// The decoded byte count, not the base64 length: iTerm2 uses it for a
// progress indicator, and a wrong one makes a large image look stalled.
test("size is the decoded byte count", () => {
  const big = new Uint8Array(3000);
  const { args, payload } = parse(encodeITerm2(big, { columns: 1, rows: 1 })[0]!);
  expect(args).toContain("size=3000");
  expect(payload.length).toBeGreaterThan(3000);
});

test("an empty payload still produces a well-formed sequence", () => {
  const { args, payload } = parse(encodeITerm2(new Uint8Array(0), { columns: 1, rows: 1 })[0]!);
  expect(args).toContain("size=0");
  expect(payload).toBe("");
});
