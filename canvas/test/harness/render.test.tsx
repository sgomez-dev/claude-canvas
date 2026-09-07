import { test, expect } from "bun:test";
import React from "react";
import { Text } from "ink";
import { renderCanvas } from "./render";

// Proves the fail-fast guard in renderCanvas() actually fires when the
// bunfig.toml preload (canvas/test/setup.ts) hasn't run — e.g. because
// `bun test` was invoked from canvas/ instead of the repository root.
// Capture-and-restore in try/finally: a failing assertion here must not
// leak a mutated TZ into every other suite that runs after this one.
test("renderCanvas throws a readable error when the test preload did not run", () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    expect(() => renderCanvas(<Text>guard check</Text>)).toThrow(/repository root/);
  } finally {
    if (originalTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTZ;
    }
  }
});
