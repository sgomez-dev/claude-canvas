import { test, expect } from "bun:test";
import { dataDir, recordPath, configPath } from "./paths";
import { homedir } from "node:os";

test("dataDir is absolute and contains the app name", () => {
  const d = dataDir();
  expect(d).toContain("claude-canvas");
  expect(d.length).toBeGreaterThan(homedir().length);
});

test("dataDir contains no /tmp", () => {
  expect(dataDir()).not.toContain("/tmp");
});

test("recordPath is under canvasesDir and ends in .json", () => {
  expect(recordPath("abc")).toEndWith("abc.json");
});

test("configPath and recordPath never collide", () => {
  expect(configPath("abc")).not.toBe(recordPath("abc"));
});
