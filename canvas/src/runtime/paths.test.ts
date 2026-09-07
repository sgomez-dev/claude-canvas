import { test, expect, afterEach } from "bun:test";
import { dataDir, recordPath, configPath, canvasesDir, logPath } from "./paths";
import { homedir } from "node:os";

// Original tests
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

// Platform-specific tests
let originalPlatformDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  delete process.env.LOCALAPPDATA;
  delete process.env.XDG_STATE_HOME;
});

test("dataDir on win32 uses LOCALAPPDATA", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env.LOCALAPPDATA = "C:\\Users\\TestUser\\AppData\\Local";

  const d = dataDir();
  expect(d).toContain("AppData");
  expect(d).toContain("Local");
  expect(d).toContain("claude-canvas");
});

test("dataDir on win32 falls back to AppData\\Local when LOCALAPPDATA missing", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  delete process.env.LOCALAPPDATA;

  const d = dataDir();
  expect(d).toContain("AppData");
  expect(d).toContain("Local");
  expect(d).toContain("claude-canvas");
});

test("dataDir on darwin uses Library/Application Support", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });

  const d = dataDir();
  expect(d).toContain("Library");
  expect(d).toContain("Application Support");
  expect(d).toContain("claude-canvas");
});

test("dataDir on linux uses XDG_STATE_HOME", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  process.env.XDG_STATE_HOME = "/home/testuser/.local/state";

  const d = dataDir();
  expect(d).toContain(".local");
  expect(d).toContain("state");
  expect(d).toContain("claude-canvas");
});

test("dataDir on linux falls back to .local/state when XDG_STATE_HOME missing", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  delete process.env.XDG_STATE_HOME;

  const d = dataDir();
  expect(d).toContain(".local");
  expect(d).toContain("state");
  expect(d).toContain("claude-canvas");
});

test("canvasesDir returns path under dataDir", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });

  const c = canvasesDir();
  expect(c).toContain("canvases");
  expect(c).toContain("claude-canvas");
});

test("logPath returns path under dataDir with .log extension", () => {
  originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });

  const l = logPath("test-id");
  expect(l).toContain("logs");
  expect(l).toContain("test-id");
  expect(l).toEndWith(".log");
});
