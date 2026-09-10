import type { CalendarEvent } from "./types";

/**
 * Date and event helpers for the calendar canvases.
 *
 * Pure functions, lifted out of calendar.tsx unchanged. They were sitting
 * between the config interface and the presentational components in a
 * 787-line file, which is how a reader ends up scrolling past the whole
 * grid to find out what `isSameDay` does.
 */

export function isAllDayEvent(event: CalendarEvent): boolean {
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
export function allDayRowCount(events: CalendarEvent[], weekDays: Date[]): number {
  const allDayEvents = events.filter(isAllDayEvent);
  if (allDayEvents.length === 0) return 0;
  let max = 1;
  for (const day of weekDays) {
    const count = allDayEvents.filter((e) => isSameDay(e.startTime, day)).length;
    if (count > max) max = count;
  }
  return max;
}


export function getWeekDays(baseDate: Date): Date[] {
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


export function formatDayName(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[date.getDay()]!; // Date.getDay() always returns 0-6, within bounds of the 7-element days array.
}


export function formatDayNumber(date: Date): string {
  return date.getDate().toString();
}


export function formatMonthYear(date: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}


export function formatHour(hour: number): string {
  if (hour === 0 || hour === 12) return "12";
  return hour < 12 ? `${hour}` : `${hour - 12}`;
}


export function getAmPm(hour: number): string {
  return hour < 12 ? "am" : "pm";
}


export function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

