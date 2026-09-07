import { test, expect } from "bun:test";
import { detectHost, NoHostError } from "./index";

test("picks tmux when TMUX is set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0" }).name).toBe("tmux");
});

test("picks wt when WT_SESSION is set", () => {
  expect(detectHost({ WT_SESSION: "abc" }).name).toBe("windows-terminal");
});

test("prefers tmux when both are set", () => {
  expect(detectHost({ TMUX: "/tmp/x,1,0", WT_SESSION: "abc" }).name).toBe("tmux");
});

test("throws a message naming what was tried when no host is available", () => {
  try {
    detectHost({});
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(NoHostError);
    expect((e as Error).message).toContain("tmux");
    expect((e as Error).message).toContain("Windows Terminal");
  }
});

test("graphics is always none in phase 1", () => {
  expect(detectHost({ TMUX: "x" }).capabilities({ TMUX: "x" }).graphics).toBe("none");
});

test("trueColor reads COLORTERM", () => {
  const h = detectHost({ TMUX: "x" });
  expect(h.capabilities({ COLORTERM: "truecolor" }).trueColor).toBe(true);
  expect(h.capabilities({}).trueColor).toBe(false);
});
