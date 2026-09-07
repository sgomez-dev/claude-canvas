import { test, expect, describe } from "bun:test";
import { assertIdent, InvalidIdentifierError } from "./validate";

describe("accepts legitimate identifiers", () => {
  for (const ok of ["calendar", "doc-1", "meeting_picker", "a", "A9-_", "x".repeat(64)]) {
    test(ok, () => expect(assertIdent("id", ok)).toBe(ok));
  }
});

describe("rejects injection payloads", () => {
  const bad = [
    "x; rm -rf /",        // the wt command-grammar split
    "x;calc",
    "a b",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    'a"b',
    "a'b",
    "a`b",
    "a$b",
    "a|b",
    "a&b",
    "a\nb",
    "calendar\n",         // trailing newline
    "",
    "x".repeat(65),
    "Ａ",                 // full-width letter U+FF21
    "‮",             // right-to-left override
    "😀",                 // emoji (astral plane / surrogate pair)
  ];
  for (const value of bad) {
    test(JSON.stringify(value), () => {
      expect(() => assertIdent("id", value)).toThrow(InvalidIdentifierError);
    });
  }
});

describe("rejects non-string types", () => {
  test("undefined", () => {
    expect(() => assertIdent("id", undefined as any)).toThrow(InvalidIdentifierError);
  });
  test("null", () => {
    expect(() => assertIdent("id", null as any)).toThrow(InvalidIdentifierError);
  });
  test("number", () => {
    expect(() => assertIdent("id", 123 as any)).toThrow(InvalidIdentifierError);
  });
  test("boolean", () => {
    expect(() => assertIdent("id", true as any)).toThrow(InvalidIdentifierError);
  });
});

test("the error names the offending field and does not echo the payload", () => {
  try {
    assertIdent("scenario", "x; calc");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidIdentifierError);
    expect((e as Error).message).toContain("scenario");
    expect((e as Error).message).not.toContain("calc");
  }
});
