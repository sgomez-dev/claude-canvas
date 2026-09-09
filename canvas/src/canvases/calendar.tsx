import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { MeetingPickerView } from "./calendar/scenarios/meeting-picker-view";
import {
  isMeetingPickerConfig,
  meetingPickerConfigError,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  type MeetingPickerConfig,
} from "../scenarios/types";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { formatTime } from "./format";
// Re-exported because this module's public surface has always included it;
// the definition now lives in one place instead of being copied here
// byte-for-byte.
export type { CalendarEvent } from "./calendar/types";
import type { CalendarEvent } from "./calendar/types";

export interface CalendarConfig {
  title?: string;
  events?: Array<{
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    color?: string;
    allDay?: boolean;
  }>;
  // Meeting picker config (when scenario is "meeting-picker")
  calendars?: MeetingPickerConfig["calendars"];
  slotGranularity?: MeetingPickerConfig["slotGranularity"];
  startHour?: number;
  endHour?: number;
}

function isAllDayEvent(event: CalendarEvent): boolean {
  if (event.allDay) return true;
  // Also detect all-day events by checking if they span midnight to midnight
  const start = event.startTime;
  const end = event.endTime;
  return start.getHours() === 0 && start.getMinutes() === 0 &&
         end.getHours() === 0 && end.getMinutes() === 0 &&
         end.getTime() - start.getTime() >= 24 * 60 * 60 * 1000;
}

// The number of rows AllDayEventsRow will actually render for the currently
// visible week. AllDayEventsRow renders one Box per event (not one shared
// row for all of them), so a day with 3 all-day events makes the whole row
// 3 rows tall, and every other day's column pads out to match (a row-flex
// container's height is its tallest child).
//
// This is 0 only when there is no all-day event ANYWHERE in `events` --
// mirroring AllDayEventsRow's own `if (allDayEvents.length === 0) return
// null` check, which is a GLOBAL test, not scoped to the visible week.
// Once that's true, the row always renders (every visible day gets at
// least a 1-row-tall cell, blank ones included via its own `: <Box
// height={1}>` fallback branch) -- so the minimum height is 1 even in the
// edge case where an all-day event exists in the config but happens to
// fall outside the currently visible week. Getting this wrong looks
// identical to the bug this fixes: rendering 3 all-day events landing
// outside the visible week still reproduced a 1-row under-count and the
// same footer overlap, caught empirically while verifying this fix.
//
// This used to be assumed to always be 0 by a hardcoded `headerHeight`
// constant that had no all-day-events term at all. A single all-day event
// already grew the real row by 1 beyond what the constant assumed for the
// no-events case, and three or more meant the JS-computed `availableHeight`
// (and therefore `visibleSlotCount`/`slotHeights`) was sized for a grid
// taller than the space Yoga actually gives the flexGrow grid box once the
// real all-day row eats into it -- grid content spilled onto the footer row,
// and with enough events an hour-boundary line got overdrawn entirely.
function allDayRowCount(events: CalendarEvent[], weekDays: Date[]): number {
  const allDayEvents = events.filter(isAllDayEvent);
  if (allDayEvents.length === 0) return 0;
  let max = 1;
  for (const day of weekDays) {
    const count = allDayEvents.filter((e) => isSameDay(e.startTime, day)).length;
    if (count > max) max = count;
  }
  return max;
}

interface Props {
  id: string;
  config?: CalendarConfig;
  enabled?: boolean;
  scenario?: string;
}

const START_HOUR = 6;
const END_HOUR = 22;

// Notion-like color palette with text colors for contrast
const INK_COLORS = ["yellow", "green", "blue", "magenta", "red", "cyan"];
// Text colors: dark for light backgrounds, white for dark backgrounds
const TEXT_COLORS: Record<string, string> = {
  yellow: "black",
  cyan: "black",
  green: "white",
  blue: "white",
  magenta: "white",
  red: "white",
};

function getWeekDays(baseDate: Date): Date[] {
  const days: Date[] = [];
  const dayOfWeek = baseDate.getDay();
  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));

  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    days.push(day);
  }
  return days;
}

function formatDayName(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[date.getDay()]!; // Date.getDay() always returns 0-6, within bounds of the 7-element days array.
}

function formatDayNumber(date: Date): string {
  return date.getDate().toString();
}

function formatMonthYear(date: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}

function formatHour(hour: number): string {
  if (hour === 0 || hour === 12) return "12";
  return hour < 12 ? `${hour}` : `${hour - 12}`;
}

function getAmPm(hour: number): string {
  return hour < 12 ? "am" : "pm";
}

function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

function getDemoEvents(): CalendarEvent[] {
  const today = new Date();
  const monday = new Date(today);
  const dayOfWeek = today.getDay();
  monday.setDate(today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));

  return [
    {
      id: "1",
      title: "Team Standup",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 9, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 9, 30),
      color: INK_COLORS[0],
    },
    {
      id: "2",
      title: "Design Review",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1, 14, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1, 15, 30),
      color: INK_COLORS[1],
    },
    {
      id: "3",
      title: "Lunch with Sarah",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 2, 12, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 2, 13, 0),
      color: INK_COLORS[2],
    },
    {
      id: "4",
      title: "Product Planning",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3, 10, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3, 11, 30),
      color: INK_COLORS[3],
    },
    {
      id: "5",
      title: "1:1 with Manager",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4, 15, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4, 16, 0),
      color: INK_COLORS[4],
    },
    {
      id: "6",
      title: "Sprint Retro",
      startTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4, 11, 0),
      endTime: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4, 12, 0),
      color: INK_COLORS[5],
    },
  ];
}

interface DayColumnProps {
  date: Date;
  events: CalendarEvent[];
  columnWidth: number;
  // Indexed by VISIBLE position (0..visibleSlotCount-1), not absolute slot
  // index -- only the window is on screen, matching the meeting picker's
  // own convention (see meeting-picker-view.tsx).
  slotHeights: number[];
  currentTime: Date;
  startHour: number;
  endHour: number;
  windowStart: number;
  visibleSlotCount: number;
}

function DayColumn({
  date,
  events,
  columnWidth,
  slotHeights,
  currentTime,
  startHour,
  endHour,
  windowStart,
  visibleSlotCount,
}: DayColumnProps) {
  // Filter to only timed events (not all-day) for this day
  const dayEvents = events.filter((e) => isSameDay(e.startTime, date) && !isAllDayEvent(e));

  // Calculate current time position for the "now" line (show on ALL days)
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const currentTimeDecimal = currentHour + currentMinute / 60;
  const showNowLine = currentHour >= startHour && currentHour < endHour;

  // Build half-hour slots (2 rows per hour), only for the VISIBLE window --
  // this used to build every slot in the day unconditionally, which is what
  // let 32 slots get rendered into an 11-row budget (see the windowing
  // comment in CalendarDisplay below).
  const slots: React.JSX.Element[] = [];

  for (let visibleIndex = 0; visibleIndex < visibleSlotCount; visibleIndex++) {
    const slotIndex = windowStart + visibleIndex;
    const hour = startHour + Math.floor(slotIndex / 2);
    const half = slotIndex % 2;
    const slotMinute = half * 30;
    const slotTime = hour + slotMinute / 60;
    const slotEndTime = slotTime + 0.5;
    const thisSlotHeight = slotHeights[visibleIndex] || 1;

    const slotEvent = dayEvents.find(e => {
      const eventStartTime = e.startTime.getHours() + e.startTime.getMinutes() / 60;
      const eventEndTime = e.endTime.getHours() + e.endTime.getMinutes() / 60;
      return slotTime >= eventStartTime && slotTime < eventEndTime;
    });

    const isEventStart = slotEvent &&
      slotEvent.startTime.getHours() === hour &&
      Math.floor(slotEvent.startTime.getMinutes() / 30) === half;
    const eventTitle = slotEvent?.title.slice(0, columnWidth - 2) || "";

    // Check if the "now" line should appear in this slot
    const nowInThisSlot = showNowLine && currentTimeDecimal >= slotTime && currentTimeDecimal < slotEndTime;
    // Calculate which line within the slot the now line should appear on
    const nowLinePosition = nowInThisSlot
      ? Math.floor(((currentTimeDecimal - slotTime) / 0.5) * thisSlotHeight)
      : -1;

    // Build content for multiple lines if thisSlotHeight > 1
    const lines: React.JSX.Element[] = [];
    for (let line = 0; line < thisSlotHeight; line++) {
      const isNowLine = line === nowLinePosition;

      if (isNowLine && !slotEvent) {
        // Draw red "now" line
        lines.push(
          <Text key={line} color="red">{"━".repeat(columnWidth - 1)}</Text>
        );
      } else if (slotEvent) {
        // Use contrasting text color based on background
        const textColor = isNowLine ? "red" : (TEXT_COLORS[slotEvent.color || "blue"] || "white");
        lines.push(
          <Text key={line} backgroundColor={slotEvent.color} color={textColor} bold>
            {line === 0 && isEventStart
              ? ` ${eventTitle}`.padEnd(columnWidth - 1)
              : " ".repeat(columnWidth - 1)}
          </Text>
        );
      } else {
        lines.push(
          <Text key={line} color="gray" dimColor>
            {line === 0 ? (half === 0 ? "─".repeat(columnWidth - 1) : "┄".repeat(columnWidth - 1)) : " ".repeat(columnWidth - 1)}
          </Text>
        );
      }
    }

    slots.push(
      <Box key={slotIndex} flexDirection="column" height={thisSlotHeight}>
        {lines}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columnWidth} flexGrow={1}>
      {/* Time slots only - headers are rendered separately */}
      <Box flexDirection="column" flexGrow={1}>
        {slots}
      </Box>
    </Box>
  );
}

interface DayHeadersRowProps {
  weekDays: Date[];
  today: Date;
  columnWidth: number;
  timeColumnWidth: number;
}

function DayHeadersRow({ weekDays, today, columnWidth, timeColumnWidth }: DayHeadersRowProps) {
  return (
    <Box>
      {/* Empty space for time column */}
      <Box width={timeColumnWidth}>
        <Text>{" "}</Text>
      </Box>
      {/* Day headers */}
      {weekDays.map((day, i) => {
        const isToday = isSameDay(day, today);
        return (
          <Box key={i} width={columnWidth} flexDirection="column">
            <Box justifyContent="center" width="100%">
              <Text color={isToday ? "blue" : "gray"}>{formatDayName(day)}</Text>
            </Box>
            <Box justifyContent="center" width="100%">
              {isToday ? (
                <Text backgroundColor="blue" color="white" bold>{` ${formatDayNumber(day)} `}</Text>
              ) : (
                <Text bold>{formatDayNumber(day)}</Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

interface AllDayRowProps {
  weekDays: Date[];
  events: CalendarEvent[];
  columnWidth: number;
  timeColumnWidth: number;
}

function AllDayEventsRow({ weekDays, events, columnWidth, timeColumnWidth }: AllDayRowProps) {
  // Get all-day events for the week
  const allDayEvents = events.filter(isAllDayEvent);

  if (allDayEvents.length === 0) {
    return null;
  }

  return (
    <Box>
      {/* Empty space for time column */}
      <Box width={timeColumnWidth}>
        <Text>{" "}</Text>
      </Box>
      {/* All-day event cells for each day */}
      {weekDays.map((day, i) => {
        const dayAllDay = allDayEvents.filter((e) => isSameDay(e.startTime, day));
        return (
          <Box key={i} width={columnWidth} flexDirection="column">
            {dayAllDay.length > 0 ? (
              dayAllDay.map((event) => {
                const textColor = TEXT_COLORS[event.color || "blue"] || "white";
                const title = event.title.slice(0, columnWidth - 2);
                return (
                  <Box key={event.id} height={1}>
                    <Text backgroundColor={event.color || "blue"} color={textColor} bold>
                      {` ${title}`.padEnd(columnWidth - 1)}
                    </Text>
                  </Box>
                );
              })
            ) : (
              <Box height={1}>
                <Text color="gray" dimColor>{" ".repeat(columnWidth - 1)}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// Thin router: calls no hooks of its own, so switching scenarios never
// changes which hooks run for a given mount (a rules-of-hooks violation the
// previous single-component version had, harmless only because the scenario
// never actually changes mid-mount). Each branch mounts a different
// component, and that component owns its own hooks.
export function Calendar({ id, config, enabled = false, scenario = "display" }: Props) {
  if (scenario === "meeting-picker") {
    // The check used to be an inline `config?.calendars` truth test whose
    // else-branch fell through to the read-only display. A caller who asked
    // for a meeting picker and got a calendar they could not pick from was
    // told nothing at all: no error anywhere, and `wait` answered `pending`
    // 55 s later. This is the type guard that check should always have
    // been, and a bad config is now reported like every other primitive's.
    if (!config || !isMeetingPickerConfig(config)) {
      // Report the SPECIFIC thing that's wrong -- calendars, slotGranularity,
      // or (once wired to actually be respected) startHour/endHour each get
      // their own distinct, actionable message.
      const message = !config
        ? "calendar config: scenario 'meeting-picker' needs a non-empty 'calendars' array"
        : meetingPickerConfigError(config) ??
          // isMeetingPickerConfig and meetingPickerConfigError agree by
          // construction (the former IS the latter's null-check), so this
          // is unreachable -- kept only so `message` always has a string.
          "calendar config: invalid 'meeting-picker' config";
      return (
        <CalendarConfigError
          id={id}
          scenario={scenario}
          enabled={enabled}
          message={message}
        />
      );
    }
    const pickerConfig: MeetingPickerConfig = {
      calendars: config.calendars,
      slotGranularity: config.slotGranularity || 30,
      title: config.title,
      startHour: config.startHour ?? DEFAULT_START_HOUR,
      endHour: config.endHour ?? DEFAULT_END_HOUR,
    };
    return <MeetingPickerView id={id} config={pickerConfig} enabled={enabled} />;
  }

  return <CalendarDisplay id={id} config={config} enabled={enabled} scenario={scenario} />;
}

interface CalendarConfigErrorProps {
  id: string;
  scenario: string;
  enabled: boolean;
  message: string;
}

// Owns a server so the error actually reaches the controller, and so the
// pane is still closable and discoverable like any other canvas.
function CalendarConfigError({ id, scenario, enabled, message }: CalendarConfigErrorProps) {
  const ipc = useCanvasServer({ id, kind: "calendar", scenario, enabled, onClose: () => {} });
  const sentRef = useRef(false);
  useEffect(() => {
    if (ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(message);
    }
  }, [ipc.isConnected, ipc.sendError, message]);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
      <Text color="red">{message}</Text>
    </Box>
  );
}

interface CalendarDisplayProps {
  id: string;
  config?: CalendarConfig;
  enabled: boolean;
  scenario: string;
}

function CalendarDisplay({ id, config, enabled, scenario }: CalendarDisplayProps) {
  // This scenario had no server at all: it started no IPC, wrote no
  // registry record, and so could not be listed, read or closed. `close`
  // answered "no canvas <id>" for a pane that was sitting right there --
  // against the lifecycle design, which requires closing to be an IPC
  // request because killing the process leaves a zombie pane on Windows.
  const ipc = useCanvasServer({
    id,
    kind: "calendar",
    scenario,
    enabled,
    onClose: () => {},
    onGet: (key) => (key === "config" ? (config ?? null) : null),
  });
  const { exit } = useApp();
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
  const footerHeight = 1; // Help bar
  const availableHeight = Math.max(1, termHeight - headerHeight - footerHeight);
  const totalSlots = (endHour - startHour) * 2; // 2 slots per hour
  const visibleSlotCount = Math.max(1, Math.min(totalSlots, availableHeight));
  const maxTimeScroll = Math.max(0, totalSlots - visibleSlotCount);
  const windowStart = Math.min(Math.max(0, timeScroll), maxTimeScroll);
  const baseSlotHeight = Math.max(1, Math.floor(availableHeight / visibleSlotCount));
  const extraRows = availableHeight - (baseSlotHeight * visibleSlotCount);
  // Create array of slot heights - first `extraRows` slots get +1 height.
  // Indexed by VISIBLE position, not absolute slot index.
  const slotHeights = Array.from({ length: visibleSlotCount }, (_, i) =>
    baseSlotHeight + (i < extraRows ? 1 : 0)
  );

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      // View-only by design: there is no "selected" outcome, so a normal
      // quit always reports cancelled -- same pattern table/picker/form/
      // diff/document all use. Without this, the registry record was
      // deleted with no outcome recorded, and a `wait` issued after a
      // normal `q` quit got "no canvas <id>" (an error) instead of the
      // "cancelled" a view-only scenario's own docs promise.
      ipc.sendCancelled("User quit");
      exit();
    } else if (input === "n" || key.rightArrow) {
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
  });

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

  // Wall-clock time for an absolute slot index, for the window-range label
  // in the footer -- mirrors the meeting picker's own `slotTime` helper.
  const slotIndexToTime = (slotIndex: number): Date => {
    const d = new Date(weekDays[0]!);
    const hour = startHour + Math.floor(slotIndex / 2);
    const minute = (slotIndex % 2) * 30;
    d.setHours(hour, minute, 0, 0);
    return d;
  };

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
          {"↑↓ scroll  •  ←/→ week  •  t today  •  q quit"}
        </Text>
      </Box>
    </Box>
  );
}
