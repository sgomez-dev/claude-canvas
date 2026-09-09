import { test, expect } from "bun:test";
import { encodeKitty, MAX_CHUNK_BASE64 } from "./kitty";

/** Splits an encoded string back into its individual APC escapes. */
function join(parts: string[]): string {
  return parts.join("");
}

function escapes(s: string): Array<{ control: string; payload: string }> {
  const out: Array<{ control: string; payload: string }> = [];
  const re = /\x1b_G([^;]*);([^\x1b]*)\x1b\\/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out.push({ control: m[1]!, payload: m[2]! });
  }
  return out;
}

const small = new Uint8Array([1, 2, 3, 4, 5]);

test("a small payload is one escape carrying all the control data", () => {
  const parts = escapes(join(encodeKitty(small, { columns: 10, rows: 4 })));
  expect(parts).toHaveLength(1);
  expect(parts[0]!.control).toBe("a=T,f=100,q=2,C=1,c=10,r=4,m=0");
  expect(Buffer.from(parts[0]!.payload, "base64")).toEqual(Buffer.from(small));
});

// Without q=2 the terminal replies on the tty, and that reply arrives on the
// canvas's stdin where Ink hands it to useInput as a keystroke.
test("responses are suppressed and the cursor is left alone", () => {
  const control = escapes(join(encodeKitty(small, { columns: 1, rows: 1 })))[0]!.control;
  expect(control).toContain("q=2");
  expect(control).toContain("C=1");
});

test("the cell box is what the caller asked for", () => {
  const control = escapes(join(encodeKitty(small, { columns: 76, rows: 22 })))[0]!.control;
  expect(control).toContain("c=76");
  expect(control).toContain("r=22");
});

// PNG bytes, not decoded pixels: the repository's own screenshot is 2 MB as a
// file and 29 MB as RGBA, which base64 turns into 39 MB.
test("the payload is the PNG bytes, sent as f=100", () => {
  const control = escapes(join(encodeKitty(small, { columns: 1, rows: 1 })))[0]!.control;
  expect(control).toContain("f=100");
});

// Kitty's own limit. An oversized single escape is dropped, not truncated,
// so this is a correctness bound rather than a politeness.
test("a payload over the chunk limit is split, and no chunk exceeds it", () => {
  const big = new Uint8Array(20_000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const parts = escapes(join(encodeKitty(big, { columns: 8, rows: 8 })));
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect(p.payload.length).toBeLessThanOrEqual(MAX_CHUNK_BASE64);
});

// The spec: the first escape carries the control data, every later one
// carries ONLY m. Repeating the control keys is a malformed request, not a
// redundant one.
test("only the first chunk carries control data, and m marks the last", () => {
  const big = new Uint8Array(20_000);
  const parts = escapes(join(encodeKitty(big, { columns: 8, rows: 8 })));
  expect(parts[0]!.control).toBe("a=T,f=100,q=2,C=1,c=8,r=8,m=1");
  for (const p of parts.slice(1, -1)) expect(p.control).toBe("m=1");
  expect(parts.at(-1)!.control).toBe("m=0");
});

test("the chunks reassemble into exactly the input bytes", () => {
  const big = new Uint8Array(20_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const parts = escapes(join(encodeKitty(big, { columns: 8, rows: 8 })));
  const rejoined = Buffer.from(parts.map((p) => p.payload).join(""), "base64");
  expect(new Uint8Array(rejoined)).toEqual(big);
});

// A boundary that lands exactly on the limit must not produce a trailing
// empty chunk, which would be an escape asking the terminal to display
// nothing after a complete transfer.
test("a payload landing exactly on the chunk boundary produces no empty tail", () => {
  // 3072 bytes base64-encode to exactly 4096 characters.
  const exact = new Uint8Array(3072);
  const parts = escapes(join(encodeKitty(exact, { columns: 2, rows: 2 })));
  expect(parts).toHaveLength(1);
  expect(parts[0]!.payload.length).toBe(MAX_CHUNK_BASE64);
  expect(parts[0]!.control).toContain("m=0");
});

test("an empty payload still produces one escape, not silence", () => {
  const parts = escapes(join(encodeKitty(new Uint8Array(0), { columns: 1, rows: 1 })));
  expect(parts).toHaveLength(1);
  expect(parts[0]!.payload).toBe("");
});
