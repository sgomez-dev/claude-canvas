import React from "react";
import { Box, Text } from "ink";
import { formatTime } from "../format";
import { TEXT_COLORS } from "./colors";
import { formatDayName, formatDayNumber, isAllDayEvent, isSameDay } from "./dates";
import type { CalendarEvent } from "./types";

/**
 * The week grid's three presentational pieces: a day's column of slots, the
 * row of day headers, and the all-day events row.
 *
 * Lifted out of calendar.tsx unchanged. They render and nothing else -- no
 * state, no IPC, no keys -- so they were the 200 lines a reader had to
 * scroll past to reach the canvas itself.
 */

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

export function DayColumn({
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

export function DayHeadersRow({ weekDays, today, columnWidth, timeColumnWidth }: DayHeadersRowProps) {
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

export function AllDayEventsRow({ weekDays, events, columnWidth, timeColumnWidth }: AllDayRowProps) {
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

