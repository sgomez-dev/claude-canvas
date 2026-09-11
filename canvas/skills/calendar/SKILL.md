---
name: calendar
description: |
  Calendar canvas for displaying events and picking meeting times.
  Use when showing calendar views or when users need to select available time slots.
---

# Calendar Canvas

Display calendar views and enable interactive meeting time selection.

## Which scenario, and read this before choosing

Two scenarios, and picking the wrong one is the mistake this canvas
actually produces in practice: someone asks to schedule something, gets
`display`, and finds a week they can look at and nothing they can click.

| The user needs to... | Scenario | Config it requires |
|---|---|---|
| **Choose** a time — schedule, find a slot, when is everyone free | `meeting-picker` | a non-empty `calendars` array |
| **See** events — show me my week, what's on Tuesday | `display` (the default) | `events`, or nothing |

`display` is **view-only**. It cannot select a time and it cannot create an
event: the arrow keys change week and that is all. If the answer you need
back is a time, it is the wrong scenario, and `spawn calendar` with no
`--scenario` gives you it.

**Neither scenario writes anywhere.** `meeting-picker` hands back
`{startTime, endTime, duration}` for the slot the person picked; putting
that into a real calendar is your job afterwards, outside this canvas. So
"block off 2-4pm on Friday" is a `meeting-picker` (or a confirmation), not
a canvas that edits a calendar.

## Example Prompts

Try asking Claude:

- "Schedule a 30-minute meeting with Alice and Bob sometime next week" — `meeting-picker`
- "Find a time when the engineering team is all free on Tuesday" — `meeting-picker`
- "When is everyone available for a 1-hour planning session?" — `meeting-picker`
- "Show me my calendar for this week" — `display`
- "What's on Thursday?" — `display`

## Scenarios

### `display` (default)
View-only calendar display. User can navigate weeks but cannot select times,
and cannot create events. If you need a time back, use `meeting-picker`
instead -- see the table at the top.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js show calendar --scenario display --config-file cfg.json
# cfg.json:
# {
#   "title": "My Week",
#   "events": [
#     {"id": "1", "title": "Meeting", "startTime": "2025-01-06T09:00:00", "endTime": "2025-01-06T10:00:00"}
#   ]
# }
```

### `meeting-picker`
Interactive scenario for selecting a free time slot when viewing multiple people's calendars.

- Shows multiple calendars overlaid with different colors
- User can **click** on free slots to select a meeting time
- Selection is sent back via IPC
- Supports configurable time slot granularity (15/30/60 min)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar --scenario meeting-picker --config '{
  "calendars": [
    {
      "name": "Alice",
      "color": "blue",
      "events": [
        {"id": "1", "title": "Standup", "startTime": "2025-01-06T09:00:00", "endTime": "2025-01-06T09:30:00"}
      ]
    },
    {
      "name": "Bob",
      "color": "green",
      "events": [
        {"id": "2", "title": "Call", "startTime": "2025-01-06T14:00:00", "endTime": "2025-01-06T15:00:00"}
      ]
    }
  ],
  "slotGranularity": 30
}'
```

## Configuration

### Display Config
```typescript
interface CalendarConfig {
  title?: string;
  events?: CalendarEvent[]; // Omit it (or pass none) and a demo week of sample events renders instead
  startHour?: number;  // First hour of the day shown (default: 6)
  endHour?: number;    // Exclusive upper bound: hours shown run from startHour up to but not
                       // including endHour (default: 22, so the last bookable slot ends at
                       // 22:00 but no slot starts at 22:00)
}

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;  // ISO datetime
  endTime: string;    // ISO datetime
  color?: string;     // blue, green, red, yellow, magenta, cyan
  allDay?: boolean;    // Renders in its own all-day row above the time grid instead of a
                       // timed slot. Also inferred automatically for an event spanning exact
                       // midnight-to-midnight, but this is the explicit way to ask for it.
}
```

### Meeting Picker Config
```typescript
interface MeetingPickerConfig {
  calendars: Calendar[];     // Must be non-empty
  slotGranularity?: number;  // 15, 30, or 60 minutes (default: 30) -- no other value is accepted
  startHour?: number;        // First hour of the day shown (default: 6)
  endHour?: number;          // Exclusive upper bound: hours shown run from startHour up to but
                             // not including endHour (default: 22, so the last bookable slot
                             // ends at 22:00 but no slot starts at 22:00)
}

interface Calendar {
  name: string;              // Person's name
  color: string;             // Calendar color
  events: CalendarEvent[];   // Their busy times
}
```

## Controls

**Display scenario:**
- `←/→` or `n`/`p`: Change week (both do the same thing -- there is no
  per-day navigation in this scenario)
- `↑/↓`: Scroll the visible time window, when the day doesn't fit the pane
- `t`: Jump to today
- `q` or `Esc`: Quit (reports `{"status":"cancelled"}` via `wait`)

**Meeting picker scenario:**
- **Mouse click**: Select a free time slot
- `↑/↓`: Move the cursor between time slots
- `←/→`: Move the cursor between days (NOT weeks -- see `n`/`p` below)
- `n`/`p`: Change week
- `Enter` or `Space`: Pick the highlighted slot
- `t`: Jump to today
- `q` or `Esc`: Cancel selection

## Selection Result

```typescript
interface MeetingSelection {
  startTime: string;  // ISO datetime
  endTime: string;    // ISO datetime
  duration: number;   // Minutes
}
```

## CLI Usage

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn calendar --scenario meeting-picker \
  --id cal-1 --config '{
    "calendars": [
      { "name": "Alice", "color": "blue", "events": [...] },
      { "name": "Bob", "color": "green", "events": [...] }
    ],
    "slotGranularity": 30
  }'

bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait cal-1
```

`wait` prints `{"status":"selected","data":{"startTime":...,"endTime":...,"duration":...}}`
once the user picks a slot, `{"status":"cancelled"}` if they quit, or
`{"status":"pending"}` if it timed out (still alive — call `wait` again).

## Keys (meeting-picker)

`↑↓←→` move the cursor, `Enter` or `Space` picks the highlighted slot,
`n`/`p` change week, `t` jumps to today, `Esc` or `q` cancels. Slots can
also be clicked; `Shift`+click or `Shift`+`Enter` skips the 3-second
confirmation countdown.

A day is, by default, 32 half-hour slots from 06:00 to 22:00 (configurable
via `startHour`/`endHour`), which is more than fits in a short pane. When it
does not fit, the grid shows as many slots as it can and pages as the
cursor crosses a boundary; the footer names the visible range
(`11:30-17:00`). Every slot stays reachable, and a click maps to the slot
actually under the pointer rather than to the same offset from the start of
the day. The `display` scenario windows and pages the same way when its own
day doesn't fit the pane, but only via `↑/↓` -- it has no mouse.

## Config errors

Asking for `--scenario meeting-picker` without a non-empty `calendars`
array is a config error, reported through `wait` as
`{"status":"error","message":"..."}`. It used to fall through silently to
the read-only display, leaving a calendar the user could not pick from and
a `wait` that answered `pending` 55 seconds later.

A `slotGranularity` other than 15, 30, or 60 is also a config error, for
the same reason: it used to reach the grid's slot-count math unchecked and
produce fractional loop bounds.

## Reading the display scenario's config

`get <id> config` returns the config a `display` calendar was given. That
scenario also had no IPC server at all until 2026-09-08, so it could not be
listed, read or closed. Quitting it with `q`/`Esc` reports
`{"status":"cancelled"}` through `wait`, the same as every other view-only
scenario in this project.
