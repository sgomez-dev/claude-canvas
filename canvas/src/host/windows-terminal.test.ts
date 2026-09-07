import { test, expect } from "bun:test";
import { windowsTerminalHost as wt } from "./windows-terminal";

const spec = { argv: ["bun", "run", "cli.ts", "show", "document"], title: "canvas: document", ratio: 0.66 };

test("available only when WT_SESSION is set", () => {
  expect(wt.isAvailable({ WT_SESSION: "guid" })).toBe(true);
  expect(wt.isAvailable({})).toBe(false);
});

test("always passes -w 0 to target the caller's existing window", () => {
  // Without -w 0, wt opens a brand new window (windowingBehavior defaults to
  // useNew). -w last targets the most-recently-USED window, which may not be
  // the caller's — unsafe.
  const argv = wt.buildArgv(spec);
  const i = argv.indexOf("-w");
  expect(i).toBeGreaterThan(0);
  expect(argv[i + 1]).toBe("0");
  expect(argv).not.toContain("last");
});

test("uses split-pane with -V for a side-by-side split", () => {
  const argv = wt.buildArgv(spec);
  expect(argv).toContain("split-pane");
  expect(argv).toContain("-V");
  expect(argv).not.toContain("-H");
});

test("passes --size for the new pane", () => {
  const argv = wt.buildArgv(spec);
  const i = argv.indexOf("--size");
  expect(i).toBeGreaterThan(0);
  expect(argv[i + 1]).toBe("0.66");
});

test("refuses any payload argument containing a semicolon", () => {
  // wt re-parses its own raw command line and splits on ";" even inside a
  // single correctly quoted argv element, turning one command into several.
  // argv arrays do not protect us here; this guard does.
  expect(() => wt.buildArgv({ ...spec, argv: ["bun", "run", "x;calc"] })).toThrow(/semicolon/i);
});

test("accepts a payload with no semicolon", () => {
  expect(() => wt.buildArgv(spec)).not.toThrow();
});
