// Shared date/time formatting for every canvas.
//
// Two separate concerns get conflated easily here, so they are separated
// explicitly:
//
// 1. WHICH INSTANT is shown. Always the host's local time -- these canvases
//    are read by a person sitting at that terminal, so a meeting slot must
//    read in their own wall-clock. Nothing here touches the timezone; the
//    Date objects already carry the process timezone.
//
// 2. HOW it is formatted. 24-hour, zero-padded, via `hourCycle: "h23"`.
//    Measured across en-US, en-GB, es-ES, de-DE, fr-FR and ja-JP: that
//    combination renders "06:05" identically in all of them, and midnight
//    as "00:00" rather than the "24:00" that a bare `hour12: false` can
//    produce under an h24 cycle. So the CLOCK is locale-independent by
//    construction, which is what keeps render snapshots stable without
//    forcing a locale on the user.
//
// The weekday is not: the same date renders "Mon", "lun", "Mo" and "月"
// across those locales. That is correct for a person reading their own
// terminal and wrong for a byte-stable snapshot, so it is the one thing
// that needs a test-only pin -- CANVAS_LOCALE, honoured by displayLocale()
// below and set in canvas/test/setup.ts. Bun ignores LANG/LC_ALL for Intl's
// default locale (measured), so an in-band knob is the only way to pin it.
export function displayLocale(): string | undefined {
  const pinned = process.env.CANVAS_LOCALE;
  return pinned && pinned.length > 0 ? pinned : undefined;
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/** Local wall-clock time, 24-hour and zero-padded: "06:05", "18:30". */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(displayLocale(), TIME_OPTIONS);
}

/** Short weekday in the reader's own locale: "Mon", "lun", "Mo". */
export function formatWeekday(date: Date): string {
  return date.toLocaleDateString(displayLocale(), { weekday: "short" });
}
