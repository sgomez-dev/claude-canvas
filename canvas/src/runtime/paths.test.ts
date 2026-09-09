import { test, expect, beforeEach, afterEach } from "bun:test";
import { dataDir, recordPath, configPath, canvasesDir, logPath } from "./paths";
import { homedir } from "node:os";
import { join } from "node:path";

// test/setup.ts pins CANVAS_DATA_DIR for the whole suite (Fix 9), which
// would otherwise make every test below observe the override instead of the
// platform-specific logic it exists to exercise. Suspend it for the
// duration of each test in this file and restore it afterward.
let savedCanvasDataDir: string | undefined;
beforeEach(() => {
  savedCanvasDataDir = process.env.CANVAS_DATA_DIR;
  delete process.env.CANVAS_DATA_DIR;
});
afterEach(() => {
  if (savedCanvasDataDir !== undefined) process.env.CANVAS_DATA_DIR = savedCanvasDataDir;
});

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

// Platform-specific tests with per-test capture-restore
test("dataDir on win32 uses LOCALAPPDATA", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalLOCALAPPDATA = process.env.LOCALAPPDATA;

  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.LOCALAPPDATA = "D:\\test-marker-win32\\data";

    const d = dataDir();
    expect(d).toContain("test-marker-win32");
    expect(d).not.toContain("AppData");
    expect(d).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
    if (originalLOCALAPPDATA !== undefined) {
      process.env.LOCALAPPDATA = originalLOCALAPPDATA;
    } else {
      delete process.env.LOCALAPPDATA;
    }
  }
});

test("dataDir on win32 falls back to AppData\\Local when LOCALAPPDATA missing", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalLOCALAPPDATA = process.env.LOCALAPPDATA;

  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.LOCALAPPDATA;

    const d = dataDir();
    expect(d).toContain("AppData");
    expect(d).toContain("Local");
    expect(d).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
    if (originalLOCALAPPDATA !== undefined) {
      process.env.LOCALAPPDATA = originalLOCALAPPDATA;
    } else {
      delete process.env.LOCALAPPDATA;
    }
  }
});

test("dataDir on darwin uses Library/Application Support", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const d = dataDir();
    expect(d).toContain("Library");
    expect(d).toContain("Application Support");
    expect(d).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
  }
});

test("dataDir on linux uses XDG_STATE_HOME", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalXDG_STATE_HOME = process.env.XDG_STATE_HOME;

  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.XDG_STATE_HOME = "/test-marker-linux/state";

    const d = dataDir();
    expect(d).toContain("test-marker-linux");
    expect(d).not.toContain(".local");
    expect(d).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
    if (originalXDG_STATE_HOME !== undefined) {
      process.env.XDG_STATE_HOME = originalXDG_STATE_HOME;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  }
});

test("dataDir on linux falls back to .local/state when XDG_STATE_HOME missing", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalXDG_STATE_HOME = process.env.XDG_STATE_HOME;

  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.XDG_STATE_HOME;

    const d = dataDir();
    expect(d).toContain(".local");
    expect(d).toContain("state");
    expect(d).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
    if (originalXDG_STATE_HOME !== undefined) {
      process.env.XDG_STATE_HOME = originalXDG_STATE_HOME;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  }
});

test("canvasesDir returns path under dataDir", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const c = canvasesDir();
    expect(c).toContain("canvases");
    expect(c).toContain("claude-canvas");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
  }
});

// Fix 9: without this override, the test suite reads/writes/prunes the
// real machine-global registry directory.
test("CANVAS_DATA_DIR overrides dataDir on every platform", () => {
  const marker = join("test-marker-override", "canvas-data");
  process.env.CANVAS_DATA_DIR = marker;
  expect(dataDir()).toBe(marker);
  expect(canvasesDir()).toBe(join(marker, "canvases"));
});

test("logPath returns path under dataDir with .log extension", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { value: "linux" });

    const l = logPath("test-id");
    expect(l).toContain("logs");
    expect(l).toContain("test-id");
    expect(l).toEndWith(".log");
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor ?? { value: "win32" });
  }
});
