import { formatTime as formatDisplayTime, displayLocale } from "../format";

// Flight Booking Canvas - Type Definitions

export interface Airport {
  code: string;        // 3-letter code, e.g., "SFO"
  name: string;        // Full name, e.g., "San Francisco International"
  city: string;        // City name, e.g., "San Francisco"
  // IANA timezone identifier, e.g. "America/Los_Angeles" -- NOT an
  // abbreviation. `formatTime` below passes this straight to
  // `Intl.DateTimeFormat`'s `timeZone` option, which only accepts IANA
  // names; a fixed abbreviation like "PST" can't express DST and isn't a
  // legal value there. `formatTimezoneAbbreviation` derives the short label
  // (e.g. "PST"/"PDT") to actually show next to a time, correct for
  // whichever side of DST the given instant falls on.
  timezone: string;
}

export interface Seatmap {
  rows: number;                // Total rows, e.g., 30
  seatsPerRow: string[];       // Seat letters, e.g., ["A", "B", "C", "D", "E", "F"]
  aisleAfter: string[];        // Aisle positions, e.g., ["C"] means aisle after seat C
  unavailable: string[];       // Blocked seats, e.g., ["1A", "1B"]
  premium: string[];           // Premium seats (exit row, extra legroom)
  occupied: string[];          // Already booked seats
}

export interface Flight {
  id: string;
  airline: string;             // e.g., "United Airlines"
  flightNumber: string;        // e.g., "UA 123"
  origin: Airport;
  destination: Airport;
  departureTime: string;       // ISO datetime string
  arrivalTime: string;         // ISO datetime string
  duration: number;            // Duration in minutes
  price: number;               // Price in cents
  currency: string;            // e.g., "USD"
  cabinClass: "economy" | "premium" | "business" | "first";
  aircraft?: string;           // e.g., "Boeing 737-800"
  stops: number;               // 0 = nonstop
  seatmap?: Seatmap;           // Optional seatmap for seat selection
}

export interface FlightConfig {
  flights: Flight[];
  title?: string;              // Optional title for the canvas
  showSeatmap?: boolean;       // Enable seat selection mode
  selectedFlightId?: string;   // Pre-select a flight by ID
}

export interface FlightResult {
  selectedFlight: Flight;
  selectedSeat?: string;       // e.g., "12A"
}

// Cyberpunk color palette
export const CYBER_COLORS = {
  neonCyan: "cyan",            // Primary accent, selected items
  neonMagenta: "magenta",      // Secondary accent, headers
  neonGreen: "green",          // Success, confirmed
  neonYellow: "yellow",        // Premium seats
  neonRed: "red",              // Occupied/unavailable
  dim: "gray",                 // Inactive/muted text
  bg: "black",                 // Background
} as const;

// Seat status for rendering
export type SeatStatus = "available" | "occupied" | "selected" | "premium" | "unavailable";

// Focus mode for keyboard navigation
export type FocusMode = "flights" | "seatmap";

// Helper to format price
export function formatPrice(cents: number, currency: string = "USD"): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(dollars);
}

// Helper to format duration
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

const FLIGHT_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

// Helper to format time from ISO string, in the reader's own local
// timezone when no `timezone` is given (delegating to the shared formatter
// so every canvas shows the same 24-hour local clock -- this used to
// hardcode en-US 12-hour, which was both a different format from the
// calendar and a locale forced on the reader), or in the GIVEN IANA
// timezone when one is passed.
//
// `timezone` used to be accepted and silently ignored: every time was
// rendered in the VIEWER's local timezone regardless, while flight-info.tsx
// printed the airport's timezone abbreviation right next to it -- a
// confidently mislabeled time whenever the viewer wasn't in that timezone.
export function formatTime(isoString: string, timezone?: string): string {
  const date = new Date(isoString);
  if (!timezone) return formatDisplayTime(date);
  return date.toLocaleTimeString(displayLocale(), { ...FLIGHT_TIME_OPTIONS, timeZone: timezone });
}

// The short zone label to show next to a `formatTime` result (e.g. "PST",
// "PDT", "GMT+2") for a given IANA timezone, evaluated AT the instant in
// question so it reflects whichever side of DST that instant actually
// falls on -- unlike a fixed abbreviation stored in config, which can't.
export function formatTimezoneAbbreviation(timezone: string, isoString: string): string {
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat(displayLocale(), {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
}

// Helper to parse seat string into row and letter
export function parseSeat(seat: string): { row: number; letter: string } | null {
  const match = seat.match(/^(\d+)([A-Z])$/);
  if (!match) return null;
  // The regex has exactly two capture groups and `match` succeeded, so both are present.
  return { row: parseInt(match[1]!, 10), letter: match[2]! };
}

// Helper to build seat string from row and letter
export function buildSeat(row: number, letter: string): string {
  return `${row}${letter}`;
}
