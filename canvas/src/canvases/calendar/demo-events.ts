import { INK_COLORS, type CalendarEvent } from "./types";

/**
 * The events the display scenario shows when a caller gives it none.
 *
 * A fixture, not production data, and 52 lines of it -- which is why it no
 * longer lives in the middle of the canvas it decorates.
 */

export function getDemoEvents(): CalendarEvent[] {
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

