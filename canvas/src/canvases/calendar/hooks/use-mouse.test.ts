import { test, expect } from "bun:test";
import { MOUSE_ENABLE, MOUSE_DISABLE, withMouseTracking } from "./use-mouse";

test("mouse tracking is disabled even when the body throws", () => {
  const writes: string[] = [];
  expect(() =>
    withMouseTracking((s) => writes.push(s), () => { throw new Error("boom"); })
  ).toThrow("boom");
  expect(writes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
});

test("mouse tracking writes through the injected sink, not process.stdout", () => {
  const writes: string[] = [];
  withMouseTracking((s) => writes.push(s), () => {});
  expect(writes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
});
