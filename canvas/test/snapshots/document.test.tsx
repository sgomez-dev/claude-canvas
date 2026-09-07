import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { Document } from "../../src/canvases/document";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { documentConfig, FIXED_CLOCK } from "../fixtures/configs";

let restore: () => void;

beforeEach(() => {
  setSystemTime(FIXED_CLOCK);
  restore = stubRealStdout();
});

afterEach(() => {
  restore();
  setSystemTime();
});

test("document display renders", async () => {
  const r = renderCanvas(
    <Document id="doc-1" config={documentConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("document display is deterministic across renders", async () => {
  const first = renderCanvas(
    <Document id="doc-1" config={documentConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const a = await first.settle();
  first.dispose();

  const second = renderCanvas(
    <Document id="doc-1" config={documentConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const b = await second.settle();
  second.dispose();

  expect(b).toBe(a);
});
