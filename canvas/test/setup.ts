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

// Locale is the third environment-dependent input, and unlike TZ it CANNOT
// be pinned from here. Bun ignores LANG/LC_ALL/LC_TIME when resolving
// Intl's default locale -- measured on 2026-09-08: with LC_ALL set to each
// of en_US.UTF-8, en_GB.UTF-8, es_ES.UTF-8 and C, `new
// Intl.DateTimeFormat().resolvedOptions().locale` stayed "en-US" on macOS,
// while the same expression follows the OS regional settings on Windows.
// So a canvas that calls toLocaleTimeString()/toLocaleDateString() with no
// locale argument (or with `[]`, which means the same thing) renders
// differently per platform, and any snapshot containing that render is
// reproducible only on the machine that captured it.
//
// The defense is an explicit locale at every call site, not an env var
// here. If a snapshot ever diverges on a rendered clock or date, look for a
// bare toLocaleTimeString()/toLocaleDateString() rather than trying to pin
// a locale in this file -- that will not work.
