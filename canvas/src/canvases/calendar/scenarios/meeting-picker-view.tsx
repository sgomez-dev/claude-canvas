// Meeting Picker View - Interactive calendar for selecting meeting times

import React, { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useMouse, type MouseEvent } from "../hooks/use-mouse";
import { useCanvasServer } from "../../../runtime/use-canvas-server";
import { formatTime, formatWeekday } from "../../format";
import { wrappedLineCount } from "../../width";
import type { MeetingPickerConfig, MeetingPickerResult, NamedCalendar } from "../../../scenarios/types";
import {
  getWeekDays,
  formatDayName,
  formatDayNumber,
  formatMonthYear,
  formatHour,
  getAmPm,
  isSameDay,
  TEXT_COLORS,
} from "../types";

interface Props {
  id: string;
  config: MeetingPickerConfig;
  enabled?: boolean;
}

// The footer's two possible static hints -- measured (via wrappedLineCount
// below) AND rendered from these same constants, so the two can never drift
// apart. Previously typed as bare literals both in a hardcoded
// `footerHeight = 2` and again in the JSX, which assumed the footer is
// always exactly a 2-line block (the move-hint line, plus the cursor-readout
// line). At narrow widths the move-hint line itself wraps -- reproduced at
// 64, 60, 58, 52, 34 and 30 columns, where "q quit" fell off the end
// entirely because the flat "2" under-reserved the real footer height, and
// the grid was sized for more rows than the pane actually left for it once
// the footer wrapped.
const FOOTER_HINT = "↑↓←→ move • Enter pick • n/p week • t today • q quit";
const COUNTDOWN_HINT = "Esc to cancel";

interface SlotInfo {
  dayIndex: number;
  slotIndex: number;
  day: Date;
  startTime: Date;
  endTime: Date;
}

// Compute the window's start slot for a candidate cursor slot, given the
// window CURRENTLY on screen.
//
// windowStart used to be a value derived fresh from cursorSlot on every
// render: `min(floor(cursorSlot / visible) * visible, total - visible)`.
// The `min(...)` cap exists so the LAST page always fills the available
// rows instead of leaving blank space when `total` isn't a multiple of
// `visible` -- but that cap means the last page's windowStart is not
// necessarily itself a multiple of `visible`. So a cursorSlot that is
// already visible on that capped last page can, when run back through the
// plain `floor(cursorSlot / visible) * visible` part of the formula,
// disagree with the capped value actually on screen -- landing one page
// EARLIER. `handleMouseMove` sets cursorSlot to whatever slot is under the
// pointer on every mouse-move event, so this mismatch meant hovering over
// a slot that was genuinely visible on the capped last page could silently
// re-page the grid with no visible change (the mouse never moved, the
// window did) -- and a subsequent click at that same pixel then booked
// whichever slot was now under it in the NEW window.
//
// The fix: only change the window when the candidate cursor slot is
// actually outside the window currently displayed. If it is already
// inside, the window is left exactly alone, so the cap-vs-floor-division
// mismatch never gets a chance to fire. The window only ever moves when
// the cursor genuinely needs a different page: real keyboard navigation
// crossing a boundary, or a resize that invalidates the current window.
// The legend row's markup, factored out of renderLegend below so
// legendLineCount can measure EXACTLY what will be rendered -- and so the
// real render and the measurement can never drift apart from each other.
//
// Deliberately a SINGLE outer <Text> with nested colored <Text> children,
// NOT a Box per calendar (marginRight-separated) the way this used to be
// written. That distinction matters: a row of independent Boxes wraps each
// one's own text independently, based on whatever width Yoga's flex-shrink
// happens to allocate it -- verified empirically to NOT be a simple linear
// word-wrap over the concatenated names (6 calendars at 80 columns really
// wraps to 3 rows that way, most of it Yoga shrinking individual boxes
// unevenly). A single wrapping Text, by contrast, flows all the nested
// spans as ONE paragraph -- which IS the greedy word-wrap
// `wrappedLineCount` (below) already models, so the two are guaranteed to
// agree on the same text. This is also why legendLineCount can stay a plain
// arithmetic function instead of needing its own nested Ink render (calling
// Ink's renderToString from inside another component's render is not
// supported -- it emits a React "nested updates" warning and was observed
// to corrupt the OUTER render's own layout, dropping whole rows).
function LegendRow({ calendars }: { calendars: NamedCalendar[] }) {
  return (
    <Text>
      {calendars.map((calendar, i) => (
        <Fragment key={i}>
          <Text backgroundColor={calendar.color} color={TEXT_COLORS[calendar.color] || "white"}>
            {` ${calendar.name} `}
          </Text>
          {i < calendars.length - 1 ? "  " : ""}
        </Fragment>
      ))}
    </Text>
  );
}

// The plain-text equivalent of LegendRow's content, for wrappedLineCount to
// measure. Must stay byte-for-byte in sync with LegendRow's actual
// characters (the per-name " name " padding and the "  " separator between
// entries) -- verified against LegendRow's real rendered output for several
// calendar counts/widths, including the 3-row case above.
function legendText(calendars: NamedCalendar[]): string {
  return calendars.map((c) => ` ${c.name} `).join("  ");
}

// Number of terminal rows the calendar-name legend will actually occupy at
// the current terminal width.
//
// This used to be baked into a hardcoded `headerHeight = 5` that assumed
// the legend was always exactly 1 row. Once enough calendars are shown, or
// their names are long enough, Ink wraps the legend onto 2+ rows -- and
// gridTop/terminalToSlot (the mouse-to-slot mapping) kept assuming the old,
// smaller header height, so a click on the row visibly showing e.g. "6am"
// booked the WRONG slot. Reproduced at 70 columns with 5 full calendar-owner
// names and 80 columns with 6.
function legendLineCount(calendars: NamedCalendar[], legendWidth: number): number {
  if (calendars.length === 0) return 1;
  return wrappedLineCount(legendText(calendars), legendWidth);
}

function nextWindowStart(
  cursorSlot: number,
  currentStart: number,
  totalSlots: number,
  visibleSlotCount: number
): number {
  if (totalSlots <= visibleSlotCount) return 0;
  const maxStart = totalSlots - visibleSlotCount;
  const clampedStart = Math.min(Math.max(0, currentStart), maxStart);
  if (cursorSlot < clampedStart || cursorSlot >= clampedStart + visibleSlotCount) {
    return Math.min(Math.floor(cursorSlot / visibleSlotCount) * visibleSlotCount, maxStart);
  }
  return clampedStart;
}

export function MeetingPickerView({ id, config, enabled = false }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [dimensions, setDimensions] = useState({
    width: stdout?.columns || 120,
    height: stdout?.rows || 40,
  });
  const [hoveredSlot, setHoveredSlot] = useState<SlotInfo | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotInfo | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null); // null = not counting, 3/2/1 = counting
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  // Keyboard cursor position (for arrow key navigation)
  const [cursorDay, setCursorDay] = useState(0);
  const [cursorSlot, setCursorSlot] = useState(0);
  const [usingKeyboard, setUsingKeyboard] = useState(true); // Start with keyboard mode
  // Sticky window start -- NOT re-derived from cursorSlot every render. See
  // `nextWindowStart` above for why that used to cause a mis-booking bug.
  const [windowStart, setWindowStart] = useState(0);
  // Mirrors of cursorSlot/windowStart, kept current via a direct write
  // inside every handler below BEFORE the corresponding setState call (same
  // pattern as cursorRef/maxLineOffsetRef in diff/view.tsx). Ink's stdin
  // handler can fire the next key's event before a prior setState from this
  // component has committed and re-rendered -- reading `cursorSlot`/
  // `windowStart` (the state, closed over at last render) in that window
  // would use a stale value and silently drop the update. Reading/writing
  // through these refs instead means every keystroke or mouse-move sees the
  // latest value regardless of whether React has re-rendered yet.
  const cursorSlotRef = useRef(cursorSlot);
  cursorSlotRef.current = cursorSlot;
  const windowStartRef = useRef(windowStart);
  windowStartRef.current = windowStart;

  // Simple ASCII spinner (single-width chars only)
  const spinnerChars = ["|", "/", "-", "\\"];

  const {
    calendars = [],
    slotGranularity = 30,
    startHour = 6,
    endHour = 22,
  } = config;

  const ipc = useCanvasServer({
    id,
    kind: "calendar",
    scenario: "meeting-picker",
    enabled,
    onClose: () => exit(),
  });

  // Countdown timer effect
  useEffect(() => {
    if (countdown === null) return;

    if (countdown === -1) {
      // Final state after checkmark shown - now exit
      exit();
      return;
    }

    if (countdown === 0) {
      // Show checkmark for 1 second, then exit
      const timer = setTimeout(() => {
        setCountdown(-1);
      }, 1000);
      return () => clearTimeout(timer);
    }

    // Tick down every second
    const timer = setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, exit]);

  // Spinner animation
  useEffect(() => {
    if (countdown === null) return;
    const interval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % spinnerChars.length);
    }, 100);
    return () => clearInterval(interval);
  }, [countdown, spinnerChars.length]);

  // Listen for terminal resize
  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({
        width: stdout?.columns || 120,
        height: stdout?.rows || 40,
      });
    };
    stdout?.on("resize", updateDimensions);
    updateDimensions();
    return () => {
      stdout?.off("resize", updateDimensions);
    };
  }, [stdout]);

  const termWidth = dimensions.width;
  const termHeight = dimensions.height;
  const timeColumnWidth = 6;
  const availableWidth = termWidth - timeColumnWidth - 4;
  const columnWidth = Math.max(12, Math.floor(availableWidth / 7));

  // Calculate slots
  const slotsPerHour = 60 / slotGranularity;
  const totalSlots = (endHour - startHour) * slotsPerHour;

  const weekDays = getWeekDays(currentDate);
  const today = new Date();

  // Absolute slot index to its wall-clock time, for the window label.
  // Defined here (rather than down by the render functions, where it used to
  // live) so the footer-height measurement below can build the exact string
  // that will be rendered.
  const slotTime = (slotIndex: number): Date => {
    const d = new Date(weekDays[0]!);
    const minutes = slotIndex * slotGranularity;
    d.setHours(startHour + Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d;
  };

  // Get slot info for the cursor's current position. Defined here (rather
  // than down by the mouse handlers, where it used to live) for the same
  // reason as slotTime above -- the footer-height measurement needs it.
  const getCursorSlotInfo = useCallback((): SlotInfo | null => {
    if (cursorDay < 0 || cursorDay >= 7) return null;
    if (cursorSlot < 0 || cursorSlot >= totalSlots) return null;

    // cursorDay is checked to be in [0, 7) above, so weekDays[cursorDay]
    // always exists.
    const day = weekDays[cursorDay]!;
    const slotMinutes = cursorSlot * slotGranularity;
    const startTime = new Date(day);
    startTime.setHours(
      startHour + Math.floor(slotMinutes / 60),
      slotMinutes % 60,
      0,
      0
    );
    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + slotGranularity);

    return { dayIndex: cursorDay, slotIndex: cursorSlot, day, startTime, endTime };
  }, [cursorDay, cursorSlot, weekDays, totalSlots, slotGranularity, startHour]);

  // Vertical budget, and the window of slots that actually fits in it.
  //
  // This used to render EVERY slot unconditionally at a height of
  // `Math.max(1, floor(availableHeight / totalSlots))`. That floor is the
  // defect: at 70x18 the budget is 11 rows while a 6:00-22:00 day at 30
  // minutes is 32 slots, so the max(1, 0) forced 32 rows into 11 and Ink
  // overlapped them -- the grid ran over the help bar, and the cursor
  // readout overwrote the start of the key hints. Both the pre- and
  // post-fix baselines of the render snapshot showed it.
  //
  // Now the grid shows as many slots as fit and pages when the cursor
  // crosses a boundary, exactly as picker, diff and table do. Every slot
  // stays reachable by navigation; none is drawn on top of another. When
  // everything fits, the slots share out the spare rows and grow taller,
  // which is the behaviour a roomy terminal had before.
  //
  // headerHeight = title (1 row) + its marginBottom (1 row) + the legend's
  // ACTUAL rendered row count (see legendLineCount above; verified against
  // real Ink output to be 1 row when the legend fits on one line, matching
  // the "5" this constant used to be hardcoded to) + the day-headers row
  // (2 rows: weekday name + day number). Root Box has paddingX={1}, so the
  // legend's available width is termWidth minus that 2-column padding.
  const legendWidth = Math.max(1, termWidth - 2);
  // Memoized: legendLineCount does a real (if small) Ink render, and this
  // component re-renders on every keystroke/mouse-move -- memoizing avoids
  // paying that cost when neither the calendar list nor the width changed.
  const legendRows = useMemo(() => legendLineCount(calendars, legendWidth), [calendars, legendWidth]);
  const headerHeight = 4 + legendRows;

  // Footer height: the actual rendered row count of the footer, not a flat
  // guess. This used to be a bare `2`, assuming the footer is always exactly
  // a 2-line block (the move-hint line, plus the cursor-readout line). At
  // narrow widths the move-hint line itself wraps -- reproduced at 64, 60,
  // 58, 52, 34 and 30 columns, where "q quit" fell off the end entirely
  // because the flat "2" under-reserved the real footer height, so the grid
  // was sized for more rows than the pane actually left for it once the
  // footer wrapped.
  //
  // Two-pass, the same shape as legendRows above and table.tsx's own
  // footerRows: the window-range label and the cursor readout both depend on
  // `visibleSlotCount`/`windowStart`, which is what this calculation itself
  // produces, so this estimates once with just the static hint to get a
  // candidate window, then measures the ACTUAL strings that window would
  // produce and re-derives the window from that. Root Box has paddingX={1},
  // so the footer's available width is the same `termWidth - 2` as the
  // legend's.
  const innerWidth = legendWidth;
  let footerRows = wrappedLineCount(FOOTER_HINT, innerWidth) + 1; // +1: baseline guess for the cursor-readout line, refined below
  let availableHeight = Math.max(1, termHeight - headerHeight - footerRows);
  let visibleSlotCount = Math.max(1, Math.min(totalSlots, availableHeight));

  const footerWindowLabel =
    totalSlots > visibleSlotCount
      ? `${formatTime(slotTime(windowStart))}-${formatTime(slotTime(windowStart + visibleSlotCount))}  `
      : "";
  const footerLine1 = footerWindowLabel + FOOTER_HINT;
  const footerCursorInfo = getCursorSlotInfo();
  // The busy suffix is measured unconditionally -- it only ever makes the
  // line LONGER, so this can never under-reserve the footer's real height.
  // It can, in the rare case a free slot's line would otherwise fit exactly
  // to the column, reserve one row more than strictly necessary. Preferred
  // over threading the real busyMap lookup (built further down, from
  // `calendars`) up to this point purely to measure a suffix -- safe in the
  // direction that matters, since over-reserving trims a row off the grid
  // while under-reserving loses the footer text.
  const footerLine2 = footerCursorInfo
    ? `${formatTime(footerCursorInfo.startTime)} - ${formatTime(footerCursorInfo.endTime)} ${formatWeekday(footerCursorInfo.day)} (busy)`
    : "";
  footerRows =
    countdown !== null && selectedSlot
      ? wrappedLineCount(COUNTDOWN_HINT, innerWidth)
      : wrappedLineCount(footerLine1, innerWidth) +
        (footerLine2 ? wrappedLineCount(footerLine2, innerWidth) : 0);
  availableHeight = Math.max(1, termHeight - headerHeight - footerRows);
  visibleSlotCount = Math.max(1, Math.min(totalSlots, availableHeight));

  // Reconcile the sticky window against genuine geometry changes only
  // (a terminal resize changing visibleSlotCount, or totalSlots changing).
  // cursorSlot changes are handled synchronously in the keyboard/mouse
  // handlers below -- this effect exists so a resize that leaves the
  // current windowStart out of range (or now-invalid) still snaps back to
  // something valid, without re-deriving on every cursor move.
  useEffect(() => {
    const next = nextWindowStart(cursorSlotRef.current, windowStartRef.current, totalSlots, visibleSlotCount);
    windowStartRef.current = next;
    setWindowStart(next);
    // cursorSlot/windowStart read via ref, not as deps: this effect is only
    // meant to react to totalSlots/visibleSlotCount changing (resize).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalSlots, visibleSlotCount]);

  const baseSlotHeight = Math.max(1, Math.floor(availableHeight / visibleSlotCount));
  const extraRows = availableHeight - baseSlotHeight * visibleSlotCount;
  // Indexed by VISIBLE position, not absolute slot index.
  const slotHeights = Array.from({ length: visibleSlotCount }, (_, i) =>
    baseSlotHeight + (i < extraRows ? 1 : 0)
  );

  // Build busy map: Map<"dayIndex-slotIndex", color[]>
  const busyMap = new Map<string, string[]>();

  for (const calendar of calendars) {
    for (const event of calendar.events) {
      const eventStart = new Date(event.startTime);
      const eventEnd = new Date(event.endTime);

      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        // weekDays always has exactly 7 elements (getWeekDays always pushes
        // 7 days), so index dayIndex (0..6) always exists.
        const day = weekDays[dayIndex]!;
        if (!isSameDay(eventStart, day) && !isSameDay(eventEnd, day)) continue;

        const dayStart = new Date(day);
        dayStart.setHours(startHour, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(endHour, 0, 0, 0);

        for (let slotIndex = 0; slotIndex < totalSlots; slotIndex++) {
          const slotStart = new Date(day);
          const slotMinutes = slotIndex * slotGranularity;
          slotStart.setHours(
            startHour + Math.floor(slotMinutes / 60),
            slotMinutes % 60,
            0,
            0
          );
          const slotEnd = new Date(slotStart);
          slotEnd.setMinutes(slotEnd.getMinutes() + slotGranularity);

          // Check if event overlaps this slot
          if (eventStart < slotEnd && eventEnd > slotStart) {
            const key = `${dayIndex}-${slotIndex}`;
            const colors = busyMap.get(key) || [];
            if (!colors.includes(calendar.color)) {
              colors.push(calendar.color);
            }
            busyMap.set(key, colors);
          }
        }
      }
    }
  }

  // Convert terminal position to slot
  const terminalToSlot = useCallback(
    (x: number, y: number): SlotInfo | null => {
      // Account for padding and time column
      const gridLeft = timeColumnWidth + 2; // 2 for paddingX
      const gridTop = headerHeight + 1;

      const relX = x - gridLeft;
      const relY = y - gridTop;

      if (relX < 0 || relY < 0) return null;

      const dayIndex = Math.floor(relX / columnWidth);
      if (dayIndex >= 7) return null;

      // Find the visible slot from cumulative heights, then map it back to
      // an absolute slot index: only the window is on screen, so a click at
      // the top of the grid is windowStart, not slot 0.
      //
      // visibleIndex starts at -1 (not 0) so a relY at or past the grid's
      // total rendered height -- a click below the last slot row, e.g. on
      // the help/footer bar -- leaves it unset and falls through to the
      // "outside the grid" return below, instead of the previous behaviour
      // of silently defaulting to the LAST slot on the last loop iteration.
      // Reproduced: clicking the help bar used to book a real meeting.
      let visibleIndex = -1;
      let cumHeight = 0;
      for (let i = 0; i < visibleSlotCount; i++) {
        // slotHeights has exactly visibleSlotCount elements (built via
        // Array.from({ length: visibleSlotCount }, ...) above), and i ranges
        // over [0, visibleSlotCount), so index i always exists.
        cumHeight += slotHeights[i]!;
        if (relY < cumHeight) {
          visibleIndex = i;
          break;
        }
      }
      if (visibleIndex === -1) return null;
      // Read through the ref, not the closed-over `windowStart` state, so a
      // click/hover that fires before a prior update has committed still
      // maps against the true current window (see the ref comments above).
      const slotIndex = windowStartRef.current + visibleIndex;

      if (slotIndex >= totalSlots) return null;

      // relX >= 0 (checked above) and columnWidth > 0, so dayIndex >= 0;
      // dayIndex < 7 is checked above, so weekDays[dayIndex] always exists.
      const day = weekDays[dayIndex]!;
      const slotMinutes = slotIndex * slotGranularity;
      const startTime = new Date(day);
      startTime.setHours(
        startHour + Math.floor(slotMinutes / 60),
        slotMinutes % 60,
        0,
        0
      );
      const endTime = new Date(startTime);
      endTime.setMinutes(endTime.getMinutes() + slotGranularity);

      return { dayIndex, slotIndex, day, startTime, endTime };
    },
    [
      weekDays,
      columnWidth,
      slotHeights,
      visibleSlotCount,
      windowStart,
      totalSlots,
      slotGranularity,
      startHour,
      timeColumnWidth,
      headerHeight,
    ]
  );

  // Check if a slot is free (no one is busy)
  const isSlotFree = useCallback(
    (dayIndex: number, slotIndex: number): boolean => {
      const key = `${dayIndex}-${slotIndex}`;
      return !busyMap.has(key);
    },
    [busyMap]
  );

  // Handle mouse events
  const handleMouseClick = useCallback(
    (event: MouseEvent) => {
      const slot = terminalToSlot(event.x, event.y);
      if (slot && isSlotFree(slot.dayIndex, slot.slotIndex)) {
        // Send selection via IPC
        const result: MeetingPickerResult = {
          startTime: slot.startTime.toISOString(),
          endTime: slot.endTime.toISOString(),
          duration: slotGranularity,
        };
        ipc.sendSelected(result);

        if (event.modifiers.shift) {
          // Power user: Shift+click skips countdown
          setSelectedSlot(slot);
          setCountdown(0); // Go straight to confirmed state
        } else {
          setSelectedSlot(slot);
          setCountdown(3); // Start 3 second countdown
        }
      }
    },
    [terminalToSlot, isSlotFree, slotGranularity, ipc]
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      const slot = terminalToSlot(event.x, event.y);
      setHoveredSlot(slot);
      setUsingKeyboard(false); // Switch to mouse mode
      // Sync cursor so keyboard continues from mouse position
      if (slot) {
        setCursorDay(slot.dayIndex);
        cursorSlotRef.current = slot.slotIndex;
        setCursorSlot(slot.slotIndex);
        // `slot` was computed from `terminalToSlot`, which maps the pixel
        // through the CURRENTLY displayed window -- so `slot.slotIndex` is
        // always already inside that window. `nextWindowStart` below is
        // therefore guaranteed to leave windowStart unchanged for a hover;
        // it only ever moves the window for real keyboard navigation. This
        // is what keeps a hover from silently re-paging the grid. Reading/
        // writing windowStartRef (not the closed-over `windowStart` state)
        // keeps this correct even if this fires again before the previous
        // update has committed.
        const next = nextWindowStart(slot.slotIndex, windowStartRef.current, totalSlots, visibleSlotCount);
        windowStartRef.current = next;
        setWindowStart(next);
      }
    },
    [terminalToSlot, totalSlots, visibleSlotCount]
  );

  useMouse({
    enabled: true,
    onClick: handleMouseClick,
    onMove: handleMouseMove,
  });

  // Keyboard controls
  useInput((input, key) => {
    if (input === "q" || key.escape) {
      if (countdown !== null) {
        // Cancel countdown, deselect
        setCountdown(null);
        setSelectedSlot(null);
      } else {
        ipc.sendCancelled("User pressed escape");
        exit();
      }
    } else if ((key.return || input === " ") && countdown === null) {
      // Select current cursor position and start countdown
      if (usingKeyboard) {
        const cursorInfo = getCursorSlotInfo();
        if (cursorInfo && isSlotFree(cursorInfo.dayIndex, cursorInfo.slotIndex)) {
          const result: MeetingPickerResult = {
            startTime: cursorInfo.startTime.toISOString(),
            endTime: cursorInfo.endTime.toISOString(),
            duration: slotGranularity,
          };
          ipc.sendSelected(result);

          if (key.shift) {
            // Power user: Shift+Enter skips countdown
            setSelectedSlot(cursorInfo);
            setCountdown(0); // Go straight to confirmed state
          } else {
            setSelectedSlot(cursorInfo);
            setCountdown(3); // Start 3 second countdown
          }
        }
      }
    } else if (key.upArrow) {
      // Move cursor up (earlier time) - cancel countdown if active
      if (countdown !== null) {
        setCountdown(null);
        setSelectedSlot(null);
      }
      setUsingKeyboard(true);
      {
        // Read/write through the refs (not the closed-over cursorSlot/
        // windowStart state) -- Ink can fire the next key's event before
        // this update has committed and re-rendered, and using the stale
        // state closure there silently drops every other keypress under
        // rapid input (reproduced with a scripted key sequence).
        const next = Math.max(0, cursorSlotRef.current - 1);
        cursorSlotRef.current = next;
        setCursorSlot(next);
        const nextWindow = nextWindowStart(next, windowStartRef.current, totalSlots, visibleSlotCount);
        windowStartRef.current = nextWindow;
        setWindowStart(nextWindow);
      }
    } else if (key.downArrow) {
      // Move cursor down (later time) - cancel countdown if active
      if (countdown !== null) {
        setCountdown(null);
        setSelectedSlot(null);
      }
      setUsingKeyboard(true);
      {
        const next = Math.min(totalSlots - 1, cursorSlotRef.current + 1);
        cursorSlotRef.current = next;
        setCursorSlot(next);
        const nextWindow = nextWindowStart(next, windowStartRef.current, totalSlots, visibleSlotCount);
        windowStartRef.current = nextWindow;
        setWindowStart(nextWindow);
      }
    } else if (key.leftArrow) {
      // Move cursor left (previous day) - cancel countdown if active
      if (countdown !== null) {
        setCountdown(null);
        setSelectedSlot(null);
      }
      setUsingKeyboard(true);
      setCursorDay((d) => Math.max(0, d - 1));
    } else if (key.rightArrow) {
      // Move cursor right (next day) - cancel countdown if active
      if (countdown !== null) {
        setCountdown(null);
        setSelectedSlot(null);
      }
      setUsingKeyboard(true);
      setCursorDay((d) => Math.min(6, d + 1));
    } else if (input === "n") {
      // Next week
      setCurrentDate((d) => {
        const next = new Date(d);
        next.setDate(d.getDate() + 7);
        return next;
      });
    } else if (input === "p") {
      // Previous week
      setCurrentDate((d) => {
        const prev = new Date(d);
        prev.setDate(d.getDate() - 7);
        return prev;
      });
    } else if (input === "t") {
      setCurrentDate(new Date());
    }
  });

  // Render time column
  const renderTimeColumn = () => {
    const slots: React.JSX.Element[] = [];
    for (let visibleIndex = 0; visibleIndex < visibleSlotCount; visibleIndex++) {
      const slotIndex = windowStart + visibleIndex;
      // slotHeights has exactly visibleSlotCount elements (see definition
      // above), and visibleIndex ranges over [0, visibleSlotCount), so the
      // index always exists.
      const height = slotHeights[visibleIndex]!;
      const slotMinutes = slotIndex * slotGranularity;
      const hour = startHour + Math.floor(slotMinutes / 60);
      const minute = slotMinutes % 60;
      const showLabel = minute === 0;

      const lines: React.JSX.Element[] = [];
      for (let line = 0; line < height; line++) {
        lines.push(
          <Text key={line} color="gray">
            {line === 0 && showLabel
              ? `${formatHour(hour)}${getAmPm(hour)}`.padStart(timeColumnWidth - 1)
              : " ".repeat(timeColumnWidth - 1)}
          </Text>
        );
      }
      slots.push(
        <Box key={slotIndex} flexDirection="column" height={height}>
          {lines}
        </Box>
      );
    }
    return slots;
  };

  // Render day column
  const renderDayColumn = (dayIndex: number) => {
    const day = weekDays[dayIndex];
    const slots: React.JSX.Element[] = [];

    for (let visibleIndex = 0; visibleIndex < visibleSlotCount; visibleIndex++) {
      const slotIndex = windowStart + visibleIndex;
      // slotHeights has exactly visibleSlotCount elements (see definition
      // above), and visibleIndex ranges over [0, visibleSlotCount), so the
      // index always exists.
      const height = slotHeights[visibleIndex]!;
      const key = `${dayIndex}-${slotIndex}`;
      const busyColors = busyMap.get(key) || [];
      const isBusy = busyColors.length > 0;
      const isHovered =
        hoveredSlot?.dayIndex === dayIndex && hoveredSlot?.slotIndex === slotIndex;
      const isSelected =
        selectedSlot?.dayIndex === dayIndex && selectedSlot?.slotIndex === slotIndex;
      const isCursor = cursorDay === dayIndex && cursorSlot === slotIndex;
      const isFree = !isBusy;

      const lines: React.JSX.Element[] = [];
      for (let line = 0; line < height; line++) {
        let content = " ".repeat(columnWidth - 1);
        let bgColor: string | undefined;
        let textColor = "gray";

        if (isSelected) {
          bgColor = "green";
          textColor = "black";
          if (countdown !== null && countdown > 0) {
            // Counting down
            const spin = spinnerChars[spinnerFrame];
            if (line === 0) {
              content = (" " + spin + " " + countdown + "...").padEnd(columnWidth - 1);
            } else if (line === 1 && height > 1) {
              content = " esc cancel".padEnd(columnWidth - 1);
            }
          } else if (countdown === 0 || countdown === -1) {
            // Confirmed - show checkmark
            if (line === 0) content = " * confirmed".padEnd(columnWidth - 1);
          } else {
            if (line === 0) content = " ok".padEnd(columnWidth - 1);
          }
        } else if (isCursor && isFree && usingKeyboard) {
          bgColor = "blue";
          textColor = "white";
          if (line === 0) content = " return".padEnd(columnWidth - 1);
        } else if (isCursor && isBusy && usingKeyboard) {
          bgColor = busyColors[0];
          textColor = "white";
          if (line === 0) content = " busy".padEnd(columnWidth - 1);
        } else if (isBusy) {
          // isBusy is true only when busyColors.length > 0 (see isBusy
          // above), so index 0 always exists.
          bgColor = busyColors[0]!;
          textColor = TEXT_COLORS[bgColor] || "white";
          if (line === 0) {
            const names = calendars
              .filter((c) => busyColors.includes(c.color))
              .map((c) => c.name)
              .join(", ");
            content = (" " + names).slice(0, columnWidth - 1).padEnd(columnWidth - 1);
          }
        } else if (isHovered && isFree && !usingKeyboard && countdown === null) {
          // Mouse hover - only show when not in countdown
          bgColor = "white";
          textColor = "black";
        } else {
          // Free slot
          const slotMinutes = slotIndex * slotGranularity;
          const minute = slotMinutes % 60;
          if (line === 0) {
            content = minute === 0 ? "─".repeat(columnWidth - 1) : "┄".repeat(columnWidth - 1);
          }
        }

        lines.push(
          <Text
            key={line}
            backgroundColor={bgColor}
            color={textColor}
            dimColor={!isBusy && !isHovered && !isSelected}
          >
            {content}
          </Text>
        );
      }

      slots.push(
        <Box key={slotIndex} flexDirection="column" height={height}>
          {lines}
        </Box>
      );
    }

    return <Box key={dayIndex} flexDirection="column" width={columnWidth}>{slots}</Box>;
  };

  // Render legend. Shares markup with LegendRow above (used to measure the
  // legend's real row count for headerHeight) so the two can never drift
  // apart from each other.
  const renderLegend = () => <LegendRow calendars={calendars} />;

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight} paddingX={1}>
      {/* Title bar */}
      <Box marginBottom={1}>
        <Text bold color="white">
          {/* weekDays always has exactly 7 elements (see getWeekDays), so
              weekDays[0] always exists. */}
          {formatMonthYear(weekDays[0]!)} - Select a meeting time
        </Text>
      </Box>

      {/* Legend */}
      {renderLegend()}

      {/* Day headers row */}
      <Box>
        <Box width={timeColumnWidth}>
          <Text> </Text>
        </Box>
        {weekDays.map((day, i) => {
          const isToday = isSameDay(day, today);
          return (
            <Box key={i} width={columnWidth} flexDirection="column">
              <Box justifyContent="center" width="100%">
                <Text color={isToday ? "blue" : "gray"}>{formatDayName(day)}</Text>
              </Box>
              <Box justifyContent="center" width="100%">
                {isToday ? (
                  <Text backgroundColor="blue" color="white" bold>
                    {` ${formatDayNumber(day)} `}
                  </Text>
                ) : (
                  <Text bold>{formatDayNumber(day)}</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Calendar time grid */}
      <Box flexGrow={1}>
        <Box flexDirection="column" width={timeColumnWidth}>
          {renderTimeColumn()}
        </Box>
        {weekDays.map((_, dayIndex) => renderDayColumn(dayIndex))}
      </Box>

      {/* Help bar */}
      <Box flexDirection="column">
        {countdown !== null && selectedSlot ? (
          <Text color="gray">{COUNTDOWN_HINT}</Text>
        ) : (
          <>
            {/* Sized to fit 70 columns with the window label prefixed: the
                previous wording plus the label overflowed and the hint was
                clipped mid-word at the right edge. Only the visible range
                is shown, not "X of Y" -- the full day is implied by being
                able to scroll to it. */}
            <Text color="gray">
              {totalSlots > visibleSlotCount
                ? `${formatTime(slotTime(windowStart))}-${formatTime(
                    slotTime(windowStart + visibleSlotCount)
                  )}  `
                : ""}
              {FOOTER_HINT}
            </Text>
            {(() => {
              const cursorInfo = getCursorSlotInfo();
              if (cursorInfo) {
                const free = isSlotFree(cursorInfo.dayIndex, cursorInfo.slotIndex);
                return (
                  <Text color={free ? "cyan" : "gray"}>
                    {/* Local wall-clock, 24-hour, via the shared formatter
                        in canvases/format.ts. See that file for why the
                        clock is locale-independent while the weekday needs
                        a test-only pin. */}
                    {formatTime(cursorInfo.startTime)}
                    {" - "}
                    {formatTime(cursorInfo.endTime)}
                    {" "}
                    {formatWeekday(cursorInfo.day)}
                    {free ? "" : " (busy)"}
                  </Text>
                );
              }
              return null;
            })()}
          </>
        )}
      </Box>
    </Box>
  );
}
