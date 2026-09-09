---
name: flight
description: |
  Flight canvas for comparing flights and selecting seats.
  Use when users need to browse flight options and book seats.
---

# Flight Canvas

Cyberpunk-themed flight comparison and seat selection interface.

## Example Prompts

Try asking Claude:

- "Find flights from San Francisco to Denver on January 15th"
- "Book me a window seat on the cheapest nonstop to NYC"
- "Compare morning flights from LAX to Seattle next Monday"
- "I need a business class seat to Chicago with extra legroom"
- "Show me United flights to Boston under $300"

## Scenarios

### `booking` (default)
Interactive flight comparison and seat selection.

- Shows flight options with airline, times, duration, and price
- Interactive seat map for seat selection
- Keyboard navigation between flights and seats
- Returns selected flight and seat via IPC

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn flight --scenario booking --config '{
  "title": "// FLIGHT_BOOKING_TERMINAL //",
  "flights": [
    {
      "id": "ua123",
      "airline": "United Airlines",
      "flightNumber": "UA 123",
      "origin": {
        "code": "SFO",
        "name": "San Francisco International",
        "city": "San Francisco",
        "timezone": "America/Los_Angeles"
      },
      "destination": {
        "code": "DEN",
        "name": "Denver International",
        "city": "Denver",
        "timezone": "America/Denver"
      },
      "departureTime": "2026-01-08T12:55:00-08:00",
      "arrivalTime": "2026-01-08T16:37:00-07:00",
      "duration": 162,
      "price": 34500,
      "currency": "USD",
      "cabinClass": "economy",
      "aircraft": "Boeing 737-800",
      "stops": 0,
      "seatmap": {
        "rows": 30,
        "seatsPerRow": ["A", "B", "C", "D", "E", "F"],
        "aisleAfter": ["C"],
        "unavailable": ["1A", "1B", "1C", "1D", "1E", "1F"],
        "premium": ["2A", "2B", "2C", "2D", "2E", "2F"],
        "occupied": ["3A", "3C", "4B", "5D"]
      }
    }
  ]
}'
```

## Configuration

```typescript
interface FlightConfig {
  flights: Flight[];
  title?: string;           // Header title
  showSeatmap?: boolean;    // Enable seat selection
  selectedFlightId?: string; // Pre-select a flight
}

interface Flight {
  id: string;
  airline: string;          // e.g., "United Airlines"
  flightNumber: string;     // e.g., "UA 123"
  origin: Airport;
  destination: Airport;
  departureTime: string;    // ISO datetime
  arrivalTime: string;      // ISO datetime
  duration: number;         // Minutes
  price: number;            // Cents
  currency: string;         // e.g., "USD"
  cabinClass: "economy" | "premium" | "business" | "first";
  aircraft?: string;        // e.g., "Boeing 737-800"
  stops: number;            // 0 = nonstop
  seatmap?: Seatmap;        // Optional seat selection
}

interface Airport {
  code: string;             // 3-letter code
  name: string;             // Full airport name
  city: string;
  timezone: string;         // IANA timezone id, e.g. "America/New_York" -- NOT an abbreviation like "PST"/"EST"
}

interface Seatmap {
  rows: number;
  seatsPerRow: string[];    // e.g., ["A", "B", "C", "D", "E", "F"]
  aisleAfter: string[];     // e.g., ["C"] = aisle after seat C
  unavailable: string[];    // Blocked seats
  premium: string[];        // Extra legroom/exit row
  occupied: string[];       // Already booked
}
```

## Controls

- `↑/↓`: Navigate between flights
- `Tab`: Switch focus between flight list and seatmap
- `←/→/↑/↓` (in seatmap): Move seat cursor
- `Space`: Select/deselect seat
- `Enter`: Confirm selection
- `Shift+Enter`: Confirm immediately (skip countdown)
- `q` or `Esc`: Cancel

## Selection Result

```typescript
interface FlightResult {
  selectedFlight: Flight;
  selectedSeat?: string;    // e.g., "12A"
}
```

## Seat Legend

- `[ ]` - Available seat
- `[X]` - Occupied seat
- `[/]` - Unavailable/blocked
- `[+]` - Premium seat (extra legroom)
- `[*]` - Currently selected

## CLI Usage

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn flight --scenario booking \
  --id flight-1 --config '{
    "flights": [
      {
        "id": "ua123",
        "airline": "United Airlines",
        "flightNumber": "UA 123",
        "origin": { "code": "SFO", "name": "San Francisco", "city": "SF", "timezone": "America/Los_Angeles" },
        "destination": { "code": "DEN", "name": "Denver", "city": "Denver", "timezone": "America/Denver" },
        "departureTime": "2026-01-08T12:55:00-08:00",
        "arrivalTime": "2026-01-08T16:37:00-07:00",
        "duration": 162,
        "price": 34500,
        "currency": "USD",
        "cabinClass": "economy",
        "stops": 0,
        "seatmap": { ... }
      }
    ]
  }'

bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait flight-1
```

`wait` prints `{"status":"selected","data":{"selectedFlight":...,"selectedSeat":"12A"}}`
once the user confirms, `{"status":"cancelled"}` if they quit, or
`{"status":"pending"}` if it timed out (still alive — call `wait` again).
