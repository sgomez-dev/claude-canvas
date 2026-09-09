import { test, expect } from "bun:test";
import { validateImage } from "./validate";
import { DEFAULT_BACKGROUND } from "../halfblocks";

test("a config with neither path nor data is rejected", () => {
  expect(validateImage(undefined).error).toBe("image config: needs a 'path' or 'data'");
  expect(validateImage({}).error).toBe("image config: needs a 'path' or 'data'");
});

// Both sources set is a caller who does not know which one is in effect, and
// silently preferring one would make the other's typo invisible.
test("a config with both path and data is rejected", () => {
  expect(validateImage({ path: "a.png", data: "abc" }).error).toBe(
    "image config: give either 'path' or 'data', not both"
  );
});

test("a path is accepted without being touched", () => {
  const v = validateImage({ path: "/does/not/exist.png" });
  expect(v.error).toBeNull();
  expect(v.source).toEqual({ kind: "path", path: "/does/not/exist.png" });
});

test("an empty or non-string path is rejected", () => {
  expect(validateImage({ path: "" }).error).toMatch(/'path' must be a non-empty string/);
  expect(validateImage({ path: 7 as never }).error).toMatch(/'path' must be a non-empty string/);
});

test("base64 data is decoded to bytes", () => {
  const v = validateImage({ data: Buffer.from([1, 2, 3, 4]).toString("base64") });
  expect(v.error).toBeNull();
  expect(v.source).toEqual({ kind: "data", bytes: new Uint8Array([1, 2, 3, 4]) });
});

test("empty or fully invalid base64 data is rejected", () => {
  expect(validateImage({ data: "" }).error).toMatch(/'data' must be a non-empty base64 string/);
  expect(validateImage({ data: "!!!!" }).error).toBe("image config: 'data' is not valid base64");
});

test("a background is parsed into channels, and defaults to black", () => {
  expect(validateImage({ path: "a.png" }).background).toEqual(DEFAULT_BACKGROUND);
  expect(validateImage({ path: "a.png", background: "#123456" }).background).toEqual({
    r: 0x12,
    g: 0x34,
    b: 0x56,
  });
  // Upper case is the same colour.
  expect(validateImage({ path: "a.png", background: "#AABBCC" }).background).toEqual({
    r: 170,
    g: 187,
    b: 204,
  });
});

// A colour that silently fell back to black would render a transparent PNG
// wrong with nothing reported, so the message names what it got.
test("a malformed background is rejected, naming the value", () => {
  for (const bad of ["123456", "#12345", "#12345g", "red", 0x123456]) {
    expect(validateImage({ path: "a.png", background: bad as never }).error).toMatch(
      /'background' must be a hex colour like "#1e2a34"/
    );
  }
});

test("a non-string title is rejected", () => {
  expect(validateImage({ path: "a.png", title: 3 as never }).error).toBe(
    "image config: 'title' must be a string"
  );
});
