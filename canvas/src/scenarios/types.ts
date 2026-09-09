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

// Meeting picker result
export interface MeetingPickerResult {
  startTime: string; // ISO datetime
  endTime: string;
  duration: number; // minutes
}

// Union type for all calendar configs
export type CalendarScenarioConfig = BaseCalendarConfig | MeetingPickerConfig;

// Type guard for meeting picker config.
//
// Requires a NON-EMPTY calendars array (an empty one is a config error --
// the message calendar.tsx reports for a bad config, and this project's own
// calendar skill doc, both already promised this) and, when present, a
// slotGranularity that's actually one of the values the grid supports --
// nothing previously enforced that at runtime, so a bad value like `7`
// reached the grid's slot-count math and produced fractional loop bounds.
export function isMeetingPickerConfig(
  config: CalendarScenarioConfig
): config is MeetingPickerConfig {
  if (!("calendars" in config) || !Array.isArray(config.calendars)) return false;
  if (config.calendars.length === 0) return false;
  if ("slotGranularity" in config && config.slotGranularity !== undefined) {
    if (!(VALID_SLOT_GRANULARITIES as readonly number[]).includes(config.slotGranularity)) {
      return false;
    }
  }
  return true;
}
