// Colour output is all-or-nothing and environment-dependent: the same frame
// measured 752 chars without colour and 1057 with. NO_COLOR does NOT override
// FORCE_COLOR, so pin it explicitly. Pin to "1", not "0" — a render refactor
// can change a colour, and stripping ANSI would hide exactly that regression.
process.env.FORCE_COLOR = "1";

// setSystemTime() in a test only fixes the epoch instant `new Date()` returns
// — it does NOT fix which timezone that instant is rendered in. These
// canvases render local time (toLocaleTimeString with no `timeZone` option,
// and getHours()/getMinutes() on a Date), so on a host whose process
// timezone isn't UTC, every snapshot would diverge from the committed
// baseline with zero code change. Pin TZ so the rendered clock is stable
// across dev machines (this project's is CET/CEST) and CI (ubuntu-latest,
// windows-latest, macos-latest).
process.env.TZ = "UTC";
