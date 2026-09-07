import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import React from "react";
import { Calendar } from "../../src/canvases/calendar";
import { renderCanvas, stubRealStdout } from "../harness/render";
import { calendarDisplayConfig, meetingPickerConfig, FIXED_CLOCK } from "../fixtures/configs";

let restore: () => void;

beforeEach(() => {
  setSystemTime(FIXED_CLOCK);
  restore = stubRealStdout();
});

afterEach(() => {
  restore();
  setSystemTime();
});

test("calendar display renders", async () => {
  const r = renderCanvas(
    <Calendar id="cal-1" config={calendarDisplayConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("calendar display is deterministic across renders", async () => {
  const first = renderCanvas(
    <Calendar id="cal-1" config={calendarDisplayConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const a = await first.settle();
  first.dispose();

  const second = renderCanvas(
    <Calendar id="cal-1" config={calendarDisplayConfig} enabled={false} scenario="display" />,
    { columns: 70, rows: 18 }
  );
  const b = await second.settle();
  second.dispose();

  expect(b).toBe(a);
});

test("calendar meeting-picker renders", async () => {
  const r = renderCanvas(
    <Calendar
      id="cal-2"
      config={{ ...calendarDisplayConfig, ...meetingPickerConfig }}
      enabled={false}
      scenario="meeting-picker"
    />,
    { columns: 70, rows: 18 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("calendar meeting-picker is deterministic across renders", async () => {
  const first = renderCanvas(
    <Calendar
      id="cal-2"
      config={{ ...calendarDisplayConfig, ...meetingPickerConfig }}
      enabled={false}
      scenario="meeting-picker"
    />,
    { columns: 70, rows: 18 }
  );
  const a = await first.settle();
  first.dispose();

  const second = renderCanvas(
    <Calendar
      id="cal-2"
      config={{ ...calendarDisplayConfig, ...meetingPickerConfig }}
      enabled={false}
      scenario="meeting-picker"
    />,
    { columns: 70, rows: 18 }
  );
  const b = await second.settle();
  second.dispose();

  expect(b).toBe(a);
});
