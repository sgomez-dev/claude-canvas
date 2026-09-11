import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { formatTime } from "../format";
import { wrappedLineCount } from "../width";
import { AllDayEventsRow, DayColumn, DayHeadersRow } from "./week-grid";
import {
  allDayRowCount,
  formatHour,
  formatMonthYear,
  getAmPm,
  getWeekDays,
  isAllDayEvent,
  type CalendarConfig,
  type CalendarEvent,
} from "./types";
import { getDemoEvents } from "./demo-events";

/** Historical defaults, used when a config declares no hours. */
const START_HOUR = 6;
const END_HOUR = 22;

// The footer's static hint text -- measured (via wrappedLineCount below) AND
// rendered from this one constant, so the two can never drift apart. This
// used to be a bare literal typed twice: once (implicitly, as "1 row") in a
// hardcoded `footerHeight = 1`, and again in the JSX. At 58 columns the
// footer (a dynamic time-range label plus this hint) really needs 2 rows,
// and the hardcoded "1" under-reserved the budget by one row -- the grid
// then rendered one row taller than the pane actually had left for it, and
// the wrapped second line (with "q quit" on it) scrolled off screen. Follows
// the same wrappedLineCount pattern already established in picker, table,
// tree, form and diff.
const FOOTER_HINT = "↑↓ scroll  •  ←/→ week  •  t today  •  q quit";

export interface CalendarDisplayViewProps {
  config?: CalendarConfig;
  /**
   * Whether this view's keys are live. Always true standalone; the prop
   * exists because every view here gates its keys the same way, and because
   * `q`/Escape is NOT among them -- that one belongs to the shell, which
   * owns the outcome.
   */
  focused?: boolean;
}

/**
 * The week grid: layout, the visible-slot window, and the keys that move
 * around it (n/p/t and the arrows).
 *
 * Knows nothing about IPC, the registry or outcomes. It deliberately does
 * NOT handle `q` or Escape: those produce the canvas's single `cancelled`
 * outcome, which is the shell's to own -- and a view that swallowed them
 * would make the shell's contract unenforceable.
 */
export function CalendarDisplayView({ config, focused = true }: CalendarDisplayViewProps) {
  const { stdout } = useStdout();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [dimensions, setDimensions] = useState({
    width: stdout?.columns || 120,
    height: stdout?.rows || 40,
  });
  // Topmost visible slot index. Kept as plain state and clamped against
  // `maxTimeScroll` on every render below (not sticky like the meeting
  // picker's windowStart) -- there is no cursor or mouse here, so nothing
  // ever sets this except the up/down handlers themselves, and clamping on
  // read is sufficient: a resize that shrinks the window just pulls the
  // clamp in, and widening it back out lets the original scroll position
  // reappear.
  const [timeScroll, setTimeScroll] = useState(0);

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute
    return () => clearInterval(timer);
  }, []);

  // Listen for terminal resize
  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({
        width: stdout?.columns || 120,
        height: stdout?.rows || 40,
      });
    };

    stdout?.on("resize", updateDimensions);
    updateDimensions(); // Initial update

    return () => {
      stdout?.off("resize", updateDimensions);
    };
  }, [stdout]);

  const termWidth = dimensions.width;
  const termHeight = dimensions.height;
  const timeColumnWidth = 6;
  const availableWidth = termWidth - timeColumnWidth - 4;
  const columnWidth = Math.max(12, Math.floor(availableWidth / 7));

  // Read the config's declared hours, falling back to the historical
  // defaults -- these used to be hardcoded module constants regardless of
  // what a caller's config actually said.
  const startHour = config?.startHour ?? START_HOUR;
  const endHour = config?.endHour ?? END_HOUR;

  const events: CalendarEvent[] = config?.events
    ? config.events.map((e) => ({
        ...e,
        startTime: new Date(e.startTime),
        endTime: new Date(e.endTime),
      }))
    : getDemoEvents();

  const weekDays = getWeekDays(currentDate);
  const today = new Date();

  // Wall-clock time for an absolute slot index, for the window-range label
  // in the footer -- mirrors the meeting picker's own `slotTime` helper.
  // Defined here (rather than down by the JSX, where it used to live) so the
  // footer-height measurement below can build the exact string that will be
  // rendered.
  const slotIndexToTime = (slotIndex: number): Date => {
    const d = new Date(weekDays[0]!);
    const hour = startHour + Math.floor(slotIndex / 2);
    const minute = (slotIndex % 2) * 30;
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  // Vertical budget, and the window of slots that actually fits in it.
  //
  // This used to render EVERY slot unconditionally at a height of
  // `Math.max(1, floor(availableHeight / totalSlots))`. That floor is the
  // same defect the meeting picker's own windowing fix already closed: at
  // 70x18 the budget is 11 rows while a 6:00-22:00 day at 30-minute
  // granularity is 32 slots, so `max(1, floor(11/32))` forced 32 rows into
  // 11 and Ink drew them on top of each other -- overwriting the help bar
  // and dropping hour labels.
  //
  // Now the grid shows as many slots as fit and pages (via the up/down
  // arrow keys -- keyboard-only, this scenario has no mouse) when
  // navigation crosses a boundary, exactly as the meeting picker does.
  //
  // headerHeight = the original hardcoded "5" (title + its marginBottom +
  // the 2-row day-headers row -- empirically confirmed to still be the
  // exact right budget for the zero-all-day-events case: at 70x18 that
  // reproduces the historical "08:00-14:00, 12 visible slots" baseline
  // byte-for-byte) + the all-day-events row's ACTUAL rendered height
  // (allDayRowCount above -- 0 when nothing is all-day, otherwise at least
  // 1, or the busiest visible day's event count if higher). This used to
  // hardcode the all-day term at 0 unconditionally: a single all-day event
  // already grew the real row by 1 beyond what the constant assumed, and
  // three or more meant the grid was sized for more rows than the space
  // actually available once the real all-day row ate into it.
  const allDayRows = allDayRowCount(events, weekDays);
  const headerHeight = 5 + allDayRows;

  // Footer height: the actual rendered row count of the footer text, not a
  // flat guess. Root Box has paddingX={1}, so the footer's available width
  // is termWidth minus that 2-column padding.
  //
  // The footer that actually renders is a dynamic time-range label (e.g.
  // "08:00-14:00  ") followed by FOOTER_HINT -- not the hint alone -- and
  // the label widens the string enough to push it onto an extra wrapped row
  // the hint-only measurement would miss. The label's own text depends on
  // `windowStart`/`visibleSlotCount`, which is what this budget calculation
  // produces, so (matching table.tsx's identical two-pass treatment) this
  // runs the estimate twice: once with just the hint to get a candidate
  // window, then measures the ACTUAL footer string that candidate would
  // produce and re-derives the window from that.
  const innerWidth = Math.max(1, termWidth - 2);
  const totalSlots = (endHour - startHour) * 2; // 2 slots per hour
  let footerRows = wrappedLineCount(FOOTER_HINT, innerWidth);
  let availableHeight = Math.max(1, termHeight - headerHeight - footerRows);
  let visibleSlotCount = Math.max(1, Math.min(totalSlots, availableHeight));
  let maxTimeScroll = Math.max(0, totalSlots - visibleSlotCount);
  let windowStart = Math.min(Math.max(0, timeScroll), maxTimeScroll);
  const actualFooter =
    (totalSlots > visibleSlotCount
      ? `${formatTime(slotIndexToTime(windowStart))}-${formatTime(
          slotIndexToTime(windowStart + visibleSlotCount)
        )}  `
      : "") + FOOTER_HINT;
  footerRows = wrappedLineCount(actualFooter, innerWidth);
  availableHeight = Math.max(1, termHeight - headerHeight - footerRows);
  visibleSlotCount = Math.max(1, Math.min(totalSlots, availableHeight));
  maxTimeScroll = Math.max(0, totalSlots - visibleSlotCount);
  windowStart = Math.min(Math.max(0, timeScroll), maxTimeScroll);
  const baseSlotHeight = Math.max(1, Math.floor(availableHeight / visibleSlotCount));
  const extraRows = availableHeight - (baseSlotHeight * visibleSlotCount);
  // Create array of slot heights - first `extraRows` slots get +1 height.
  // Indexed by VISIBLE position, not absolute slot index.
  const slotHeights = Array.from({ length: visibleSlotCount }, (_, i) =>
    baseSlotHeight + (i < extraRows ? 1 : 0)
  );

  useInput((input, key) => {
    if (input === "n" || key.rightArrow) {
      setCurrentDate((d) => {
        const next = new Date(d);
        next.setDate(d.getDate() + 7);
        return next;
      });
    } else if (input === "p" || key.leftArrow) {
      setCurrentDate((d) => {
        const prev = new Date(d);
        prev.setDate(d.getDate() - 7);
        return prev;
      });
    } else if (input === "t") {
      setCurrentDate(new Date());
    } else if (key.upArrow) {
      // Scroll the time window earlier. Clamped against the CURRENT
      // maxTimeScroll (not just >= 0) so a scroll queued right before a
      // resize can't leave timeScroll above the new, smaller maximum.
      setTimeScroll((s) => Math.max(0, Math.min(s, maxTimeScroll) - 1));
    } else if (key.downArrow) {
      // Scroll the time window later.
      setTimeScroll((s) => Math.min(maxTimeScroll, Math.max(0, s) + 1));
    }
  }, { isActive: focused });

  // Build time column (2 rows per hour, matching slot heights), only for
  // the VISIBLE window -- see the windowing comment above.
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const currentTimeDecimal = currentHour + currentMinute / 60;
  const showNowIndicator = currentHour >= startHour && currentHour < endHour;

  const timeSlots: React.JSX.Element[] = [];
  for (let visibleIndex = 0; visibleIndex < visibleSlotCount; visibleIndex++) {
    const slotIndex = windowStart + visibleIndex;
    const hour = startHour + Math.floor(slotIndex / 2);
    const half = slotIndex % 2;
    const slotTime = hour + (half * 30) / 60;
    const slotEndTime = slotTime + 0.5;
    const height = slotHeights[visibleIndex] || 1;

    const nowInSlot = showNowIndicator && currentTimeDecimal >= slotTime && currentTimeDecimal < slotEndTime;
    const nowLinePosition = nowInSlot
      ? Math.floor(((currentTimeDecimal - slotTime) / 0.5) * height)
      : -1;

    const lines: React.JSX.Element[] = [];
    for (let line = 0; line < height; line++) {
      const isNowLine = line === nowLinePosition;
      if (isNowLine) {
        // Show current time in red (12-hour format)
        const hour12 = currentHour === 0 ? 12 : currentHour > 12 ? currentHour - 12 : currentHour;
        const ampm = currentHour < 12 ? "a" : "p";
        const timeStr = `${hour12}:${currentMinute.toString().padStart(2, "0")}${ampm}`;
        lines.push(
          <Text key={line} color="red" bold>
            {timeStr.padStart(timeColumnWidth - 1)}
          </Text>
        );
      } else if (half === 0 && line === 0) {
        // Hour label only on the first half-hour of an hour, matching the
        // original per-hour rendering.
        lines.push(
          <Text key={line} color="gray">
            {`${formatHour(hour)}${getAmPm(hour)}`.padStart(timeColumnWidth - 1)}
          </Text>
        );
      } else {
        lines.push(<Text key={line}>{" "}</Text>);
      }
    }
    timeSlots.push(
      <Box key={slotIndex} flexDirection="column" height={height} width={timeColumnWidth}>
        {lines}
      </Box>
    );
  }

  // Check if there are any all-day events
  const hasAllDayEvents = events.some(isAllDayEvent);

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight} paddingX={1}>
      {/* Title bar */}
      <Box marginBottom={1}>
        {/* getWeekDays always returns 7 entries, so index 0 exists. */}
        <Text bold color="white">{formatMonthYear(weekDays[0]!)}</Text>
      </Box>

      {/* Day headers row */}
      <DayHeadersRow
        weekDays={weekDays}
        today={today}
        columnWidth={columnWidth}
        timeColumnWidth={timeColumnWidth}
      />

      {/* All-day events row (if any) */}
      {hasAllDayEvents && (
        <AllDayEventsRow
          weekDays={weekDays}
          events={events}
          columnWidth={columnWidth}
          timeColumnWidth={timeColumnWidth}
        />
      )}

      {/* Calendar time grid */}
      <Box flexGrow={1}>
        {/* Time column */}
        <Box flexDirection="column" width={timeColumnWidth}>
          {timeSlots}
        </Box>

        {/* Day columns (time slots only) */}
        {weekDays.map((day, i) => (
          <DayColumn
            key={i}
            date={day}
            events={events}
            columnWidth={columnWidth}
            slotHeights={slotHeights}
            currentTime={currentTime}
            startHour={startHour}
            endHour={endHour}
            windowStart={windowStart}
            visibleSlotCount={visibleSlotCount}
          />
        ))}
      </Box>

      {/* Help bar */}
      <Box>
        <Text color="gray">
          {totalSlots > visibleSlotCount
            ? `${formatTime(slotIndexToTime(windowStart))}-${formatTime(
                slotIndexToTime(windowStart + visibleSlotCount)
              )}  `
            : ""}
          {FOOTER_HINT}
        </Text>
      </Box>
    </Box>
  );
}
