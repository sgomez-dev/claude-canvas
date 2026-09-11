import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The one locale-dependent render left after canvases/format.ts made the
// clock locale-independent: the short weekday, which is "Mon" in en-GB,
// "lun" in es-ES, "Mo" in de-DE and "月" in ja-JP. Production reads
// CANVAS_LOCALE as unset and formats in the host's own locale, which is what
// a person at that terminal should see; snapshots pin it here so a baseline
// captured on one machine reproduces on another. en-GB chosen only because
// it is what the existing baselines were captured under.
process.env.CANVAS_LOCALE = "en-GB";

// The image tier is the fourth environment-dependent input, and it decides
// which VIEW the image canvas renders: `halfblocks` paints through Ink as
// styled text, while kitty, iTerm2 and Sixel reserve blank rows and paint
// with a terminal protocol. detectGraphics reads TERM_PROGRAM and TERM, so
// without this pin the suite would behave differently for a developer
// running kitty or Ghostty than for one running Apple Terminal -- the image
// snapshots would capture reserved blank rows instead of half-blocks, and
// nothing in the production code would have changed.
//
// Pinned to the baseline tier because that is the one whose output is
// ordinary text and therefore snapshottable. The tests that exercise a
// protocol tier set CANVAS_GRAPHICS themselves, per test.
process.env.CANVAS_GRAPHICS = "halfblocks";

// CANVAS_GRAPHICS above pins the TIER, but any test that deliberately clears
// it to exercise detectGraphics itself (there is exactly one: "with no
// override, a plain terminal detects quadrants" in
// test/integration/image-tiers.test.tsx) falls straight through to whatever
// terminal-identity variables happen to be set in the REAL environment this
// test run happens to execute in. detectGraphics/resolveGraphics
// (host/graphics.ts) and outerTerminalEnv (host/terminal-probe.ts) key off
// all of these, independently of TERM -- so pinning TERM/TERM_PROGRAM alone,
// which that test already does itself, is not enough. Confirmed directly:
// with WT_SESSION set (a real Windows Terminal session, or simply a
// developer who has one open elsewhere and inherited it), that test detected
// "sixel" instead of "quadrants" -- 9 pass/1 fail -- because WT_SESSION is
// checked independently of TERM/TERM_PROGRAM and neither of that test's two
// pins touched it. 10 pass/0 fail with it removed.
//
// Deleted (not pinned to a fixed value) because, unlike CANVAS_GRAPHICS,
// there is no "unset" tier to pin to -- these variables are meaningful only
// by their PRESENCE, and every test that wants one set (e.g. the sixel/kitty
// tier tests, and terminal-probe.test.ts) sets it on a plain object it
// constructs itself rather than on process.env.
for (const terminalIdentityVar of [
  "WT_SESSION",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "KITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR",
  "WEZTERM_EXECUTABLE",
  "LC_TERMINAL",
  // Not read by detectGraphics today, but iTerm2 sets it in every real
  // session and a future LC_TERMINAL-style check on it is exactly the kind
  // of addition that would otherwise silently reintroduce this leak class.
  "ITERM_SESSION_ID",
  // Read by resolveGraphics/systemProbe to decide whether to run the
  // process-tree probe at all (host/graphics.ts, host/terminal-probe.ts). A
  // developer running the suite from inside a real tmux session would
  // otherwise leak TMUX/TMUX_PANE in, sending detection down the probe path
  // instead of the plain-environment path the tests intend to exercise.
  "TMUX",
  "TMUX_PANE",
]) {
  delete process.env[terminalIdentityVar];
}

// Without this, the whole test suite reads, writes, and PRUNES the real
// machine-global canvas registry directory (%LOCALAPPDATA%\claude-canvas on
// Windows, ~/Library/Application Support/claude-canvas on macOS, etc.) --
// which any real canvas the developer has running also uses. That produced
// real test interference: a stale record left by an interrupted run caused
// spurious failures in unrelated tests later. CANVAS_DATA_DIR (paths.ts)
// redirects dataDir() here instead, isolating every test run to its own
// throwaway directory. A pid + timestamp suffix keeps concurrent test runs
// (e.g. two `bun test` invocations) from colliding on the same directory.
process.env.CANVAS_DATA_DIR = join(tmpdir(), `claude-canvas-test-${process.pid}-${Date.now()}`);
