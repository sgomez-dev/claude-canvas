import { test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { formatTime, formatTimezoneAbbreviation, type Flight } from "./types";
import { FlightInfo } from "./components/flight-info";

// `formatTime(isoString, timezone?)` used to accept `timezone` and silently
// ignore it -- every time rendered in the VIEWER's local timezone
// regardless, while flight-info.tsx printed the airport's timezone
// abbreviation right next to it: a confidently mislabeled time whenever the
// viewer wasn't actually in that timezone. This is the regression test for
// making it genuinely timezone-aware via Intl.DateTimeFormat's `timeZone`
// option.
//
// January is used (not the March fixture date) specifically to sidestep US
// DST, so this test's expectation doesn't depend on which side of a DST
// transition the date happens to fall.
const WINTER_UTC = "2026-01-15T20:00:00.000Z";

test("formatTime with no timezone renders in the process's own local time", () => {
  // test/setup.ts pins TZ=UTC for the whole suite, so "local" here is UTC.
  expect(formatTime(WINTER_UTC)).toBe("20:00");
});

test("formatTime with an IANA timezone renders AS IT WOULD APPEAR there, not in the viewer's local time", () => {
  // 20:00 UTC in January is 15:00 in America/New_York (UTC-5, no DST in
  // winter) -- a genuinely different wall-clock hour from the no-timezone
  // case above, proving the parameter is actually consulted now.
  expect(formatTime(WINTER_UTC, "America/New_York")).toBe("15:00");
  // And a second, different IANA zone to rule out a hardcoded offset.
  expect(formatTime(WINTER_UTC, "Asia/Tokyo")).toBe("05:00"); // next day, UTC+9
});

test("formatTimezoneAbbreviation reflects the zone actually passed, not a stored label", () => {
  const ny = formatTimezoneAbbreviation("America/New_York", WINTER_UTC);
  const tokyo = formatTimezoneAbbreviation("Asia/Tokyo", WINTER_UTC);
  expect(ny).not.toBe(tokyo);
  expect(typeof ny).toBe("string");
  expect(ny.length).toBeGreaterThan(0);
});

// Regression test for the flight/SKILL.md docs bug: the docs told users to
// write `"timezone": "PST"` (an abbreviation, not a legal IANA id).
// `Intl.DateTimeFormat`'s `timeZone` option only accepts real IANA
// identifiers (or a handful of legacy fixed-offset aliases) -- constructing
// one with "PST" throws `RangeError: invalid time zone: PST` SYNCHRONOUSLY.
// Before this fix, that RangeError propagated straight out of
// flight-info.tsx's render, crashing the whole canvas with Ink's raw error
// screen instead of showing the booking UI. Both functions must now
// validate before ever handing the caller's string to Intl, and fall back
// instead of throwing.
test("formatTime with an invalid (non-IANA) timezone string does not throw, and falls back to local time", () => {
  expect(() => formatTime(WINTER_UTC, "PST")).not.toThrow();
  // Falls back to the same rendering as no timezone at all.
  expect(formatTime(WINTER_UTC, "PST")).toBe(formatTime(WINTER_UTC));
});

test("formatTimezoneAbbreviation with an invalid (non-IANA) timezone string does not throw", () => {
  expect(() => formatTimezoneAbbreviation("PST", WINTER_UTC)).not.toThrow();
  // Cosmetic fallback: echoes the raw string back rather than crashing.
  expect(formatTimezoneAbbreviation("PST", WINTER_UTC)).toBe("PST");
});

test("legacy fixed-offset aliases like MST/EST/GMT/UTC are still accepted (they don't throw), even though they're DST-unaware", () => {
  for (const legacy of ["MST", "EST", "GMT", "UTC"]) {
    expect(() => formatTime(WINTER_UTC, legacy)).not.toThrow();
    expect(() => formatTimezoneAbbreviation(legacy, WINTER_UTC)).not.toThrow();
  }
});

// The concrete failure from the bug report: rendering the flight canvas'
// FlightInfo panel (the actual component whose render path called
// formatTime/formatTimezoneAbbreviation with an unvalidated timezone) with
// the documented `"timezone": "PST"` config value used to throw a
// RangeError out of the render tree. This exercises the real component via
// Ink's synchronous renderToString, not just the underlying helpers, so it
// proves the fix actually reaches the render path that crashed.
test("rendering FlightInfo with an invalid timezone does not crash and produces a reasonable fallback display", () => {
  const flight: Flight = {
    id: "ua123",
    airline: "United Airlines",
    flightNumber: "UA 123",
    origin: { code: "SFO", name: "San Francisco International", city: "San Francisco", timezone: "PST" },
    destination: { code: "DEN", name: "Denver International", city: "Denver", timezone: "MST" },
    departureTime: "2026-01-08T12:55:00-08:00",
    arrivalTime: "2026-01-08T16:37:00-07:00",
    duration: 162,
    price: 34500,
    currency: "USD",
    cabinClass: "economy",
    aircraft: "Boeing 737-800",
    stops: 0,
  };

  let output = "";
  expect(() => {
    output = renderToString(React.createElement(FlightInfo, { flight }), { columns: 80 });
  }).not.toThrow();

  // A reasonable fallback display: still shows a time, not blank/garbage.
  expect(output).toContain("United Airlines UA 123");
  expect(output).toMatch(/\d{2}:\d{2}/);
});
