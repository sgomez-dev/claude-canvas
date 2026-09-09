import { test, expect } from "bun:test";
import { formatTime, formatTimezoneAbbreviation } from "./types";

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
