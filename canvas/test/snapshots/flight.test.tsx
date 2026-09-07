import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { FlightCanvas } from "../../src/canvases/flight";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { flightConfig, FIXED_CLOCK } from "../fixtures/configs";

let restore: () => void;

beforeEach(() => {
  setSystemTime(FIXED_CLOCK);
  restore = stubRealStdout();
});

afterEach(() => {
  restore();
  setSystemTime();
});

test("flight booking renders", async () => {
  const r = renderCanvas(
    <FlightCanvas id="flight-1" config={flightConfig} enabled={false} scenario="booking" />,
    { columns: 70, rows: 18 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("flight booking is deterministic across renders", async () => {
  const first = renderCanvas(
    <FlightCanvas id="flight-1" config={flightConfig} enabled={false} scenario="booking" />,
    { columns: 70, rows: 18 }
  );
  const a = await first.settle();
  first.dispose();

  const second = renderCanvas(
    <FlightCanvas id="flight-1" config={flightConfig} enabled={false} scenario="booking" />,
    { columns: 70, rows: 18 }
  );
  const b = await second.settle();
  second.dispose();

  expect(b).toBe(a);
});
