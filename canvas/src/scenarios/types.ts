// Scenario System Types

/**
 * What a scenario lets the user do. Consumed by the `scenarios` CLI verb,
 * which is how a controller discovers whether to expect a result at all: a
 * "view-only" scenario has no `selected` outcome, so its `wait` ending in
 * `cancelled` is success rather than failure.
 */
export type InteractionMode = "view-only" | "selection" | "multi-select";

/**
 * A scenario is the (kind, name) pair the CLI accepts after `--scenario`,
 * plus enough metadata to describe it.
 *
 * This used to also carry `closeOn`, `autoCloseDelay` and `defaultConfig`,
 * and two generic parameters that existed only to type the last of them.
 * All were removed: nothing read any of them, every canvas hardcodes its
 * own closing behaviour and its own defaults, and a field that describes
 * behaviour without causing it is worse than no field -- it reads as a
 * contract to whoever finds it next.
 */
export interface ScenarioDefinition {
  name: string;
  description: string;
  canvasKind: string;
  interactionMode: InteractionMode;
}

// A calendar event as it arrives in a --config payload: times are ISO
// strings, because that is what survives JSON.
//
// Deliberately NOT called `CalendarEvent`. There is a runtime
// `CalendarEvent` in canvases/calendar/types.ts whose startTime/endTime are
// `Date`, and having both shapes share one name across the codebase meant
// two different types were indistinguishable at a glance and interchangeable
// to no one. This is the wire shape; that is the parsed shape.
export interface CalendarEventInput {
  id: string;
  title: string;
  startTime: string; // ISO datetime
  endTime: string;
  color?: string;
  allDay?: boolean;
}

// Calendar with named owner for multi-calendar scenarios
export interface NamedCalendar {
  name: string;
  color: string;
  events: CalendarEventInput[];
}

// Base calendar config (used by display scenario)
export interface BaseCalendarConfig {
  title?: string;
  events?: CalendarEventInput[];
  startHour?: number;
  endHour?: number;
}

// Meeting picker specific config
export interface MeetingPickerConfig extends BaseCalendarConfig {
  calendars: NamedCalendar[];
  slotGranularity: 15 | 30 | 60; // minutes
}

// The only granularities the grid actually supports: each divides evenly
// into a full hour, which the slot-to-time-of-day math throughout the
// meeting picker assumes.
const VALID_SLOT_GRANULARITIES = [15, 30, 60] as const;

// Historical defaults for startHour/endHour, shared with calendar.tsx so
// this module's validation checks the same effective values calendar.tsx
// will actually use once a caller omits one or both.
export const DEFAULT_START_HOUR = 6;
export const DEFAULT_END_HOUR = 22;

// Meeting picker result
export interface MeetingPickerResult {
  startTime: string; // ISO datetime
  endTime: string;
  duration: number; // minutes
}

// Union type for all calendar configs
export type CalendarScenarioConfig = BaseCalendarConfig | MeetingPickerConfig;

// Validates a meeting-picker config and returns the SPECIFIC reason it's
// invalid (a ready-to-report message), or `null` when it's fine.
// isMeetingPickerConfig (below) is a thin boolean wrapper around this; both
// exist so calendar.tsx can report calendars/slotGranularity/startHour/
// endHour problems with a distinct, actionable message each, rather than a
// generic "invalid config".
//
// Checks:
// - a NON-EMPTY `calendars` array (an empty one is a config error -- the
//   message calendar.tsx reports for a bad config, and this project's own
//   calendar skill doc, both already promised this)
// - when present, a `slotGranularity` that's actually one of the values the
//   grid supports -- nothing previously enforced that at runtime, so a bad
//   value like `7` reached the grid's slot-count math and produced
//   fractional loop bounds
// - `startHour`/`endHour` (evaluated against their historical defaults when
//   omitted, so a partial override like `{startHour: 23}` is checked
//   against the OTHER field's real effective value, not just its own raw
//   presence). These were wired to actually be respected in an earlier fix
//   but left completely unvalidated: negative hours make `setHours(-5,
//   ...)` silently roll back to the previous day (a booking made from a
//   picker showing a "6am" label under an otherwise-correct day header
//   actually books the PREVIOUS day); an inverted or equal pair produces
//   zero or negative total slots, rendering nothing selectable with no
//   error at all; fractional values produce fractional loop bounds
//   internally. `endHour: 24` (midnight, end of day) is allowed on purpose
//   -- exclusive upper bound, so 24 never itself becomes a bookable slot.
// Shared startHour/endHour validation for every calendar scenario that
// accepts these two fields (currently 'meeting-picker' and 'display'), so
// the integer/range/ordering rules live in exactly one place rather than
// being copied into each scenario's own config-error function and drifting
// apart. `scenarioName` only changes which scenario the reported message
// names -- the checks themselves are identical for both callers, and both
// evaluate them against the field's EFFECTIVE value (the config's own value
// if present, otherwise the shared historical default), so a partial
// override like `{startHour: 23}` is checked against the other field's real
// effective value, not just its own raw presence.
function calendarHourRangeError(scenarioName: string, startHour: number, endHour: number): string | null {
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    return `calendar config: scenario '${scenarioName}' needs 'startHour' to be an integer from 0 to 23`;
  }
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
    return `calendar config: scenario '${scenarioName}' needs 'endHour' to be an integer from 1 to 24`;
  }
  if (startHour >= endHour) {
    return `calendar config: scenario '${scenarioName}' needs 'startHour' to be strictly less than 'endHour'`;
  }
  return null;
}

export function meetingPickerConfigError(config: CalendarScenarioConfig): string | null {
  if (!("calendars" in config) || !Array.isArray(config.calendars) || config.calendars.length === 0) {
    return "calendar config: scenario 'meeting-picker' needs a non-empty 'calendars' array";
  }
  if ("slotGranularity" in config && config.slotGranularity !== undefined) {
    if (!(VALID_SLOT_GRANULARITIES as readonly number[]).includes(config.slotGranularity)) {
      return "calendar config: scenario 'meeting-picker' needs 'slotGranularity' to be 15, 30, or 60";
    }
  }
  const startHour = "startHour" in config && config.startHour !== undefined ? config.startHour : DEFAULT_START_HOUR;
  const endHour = "endHour" in config && config.endHour !== undefined ? config.endHour : DEFAULT_END_HOUR;
  return calendarHourRangeError("meeting-picker", startHour, endHour);
}

// Validates the 'display' scenario's config. Its shape (BaseCalendarConfig)
// has no 'calendars' or 'slotGranularity' -- only 'events'/'startHour'/
// 'endHour' -- so this only needs the startHour/endHour checks, delegated
// to the same calendarHourRangeError meetingPickerConfigError uses above.
//
// Before this existed, calendar.tsx's display scenario read
// `config?.startHour ?? START_HOUR` / `config?.endHour ?? END_HOUR` with no
// validation at all: an inverted, equal, negative, or fractional pair
// silently produced a broken grid (zero or negative `totalSlots`, garbled
// hour labels from a non-integer hour) with no error ever reported to the
// controller. meeting-picker already closed this exact gap for itself;
// display is lower severity (view-only, no booking action to silently
// record a wrong time) but the same category of gap.
export function displayConfigError(config: BaseCalendarConfig): string | null {
  const startHour = config.startHour !== undefined ? config.startHour : DEFAULT_START_HOUR;
  const endHour = config.endHour !== undefined ? config.endHour : DEFAULT_END_HOUR;
  return calendarHourRangeError("display", startHour, endHour);
}

// Type guard for meeting picker config. See meetingPickerConfigError above
// for what specifically is checked.
export function isMeetingPickerConfig(
  config: CalendarScenarioConfig
): config is MeetingPickerConfig {
  return meetingPickerConfigError(config) === null;
}
