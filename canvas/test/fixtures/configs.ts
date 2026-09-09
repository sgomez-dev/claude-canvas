import type { DocumentConfig } from "../../src/canvases/document/types";
import type { FlightConfig } from "../../src/canvases/flight/types";

// Two of the three canvases render live clocks, so every fixture pins the
// clock. cyberpunk-header.tsx:28 renders new Date().toLocaleTimeString() and
// calendar.tsx:367 keeps a currentTime on a setInterval.
export const FIXED_CLOCK = new Date("2026-03-15T09:30:00.000Z");

export const documentConfig: DocumentConfig = {
  title: "Quarterly Review",
  content: "# Heading\n\nSome **bold** text.\n\n- one\n- two\n",
};

export const calendarDisplayConfig = {
  title: "Team Calendar",
  events: [
    {
      id: "e1",
      title: "Standup",
      startTime: "2026-03-15T09:00:00.000Z",
      endTime: "2026-03-15T09:15:00.000Z",
    },
  ],
  startHour: 8,
  endHour: 18,
};

export const meetingPickerConfig = {
  calendars: [
    {
      name: "Ana",
      color: "cyan",
      events: [
        {
          id: "b1",
          title: "Busy",
          startTime: "2026-03-15T10:00:00.000Z",
          endTime: "2026-03-15T11:00:00.000Z",
        },
      ],
    },
  ],
  slotGranularity: 30 as const,
};

// The brief's flight fixture omitted several fields the real `Flight`/`Airport`
// types (canvas/src/canvases/flight/types.ts) require: Airport.name and
// Airport.timezone, and Flight.duration, Flight.currency, Flight.cabinClass,
// Flight.stops. Added below so this compiles against FlightConfig without
// loosening the type.
export const flightConfig: FlightConfig = {
  title: "// FLIGHT_BOOKING_TERMINAL //",
  flights: [
    {
      id: "ua123",
      airline: "United Airlines",
      flightNumber: "UA 123",
      origin: { code: "SFO", name: "San Francisco International", city: "San Francisco", timezone: "America/Los_Angeles" },
      destination: { code: "DEN", name: "Denver International", city: "Denver", timezone: "America/Denver" },
      departureTime: "2026-03-15T08:00:00.000Z",
      arrivalTime: "2026-03-15T11:30:00.000Z",
      duration: 210,
      price: 289,
      currency: "USD",
      cabinClass: "economy",
      stops: 0,
    },
  ],
};
