// Scenario System Types

export type InteractionMode = "view-only" | "selection" | "multi-select";
export type CloseOn = "selection" | "escape" | "command" | "never";

export interface ScenarioDefinition<
  TConfig = unknown,
  TResult = unknown
> {
  name: string;
  description: string;
  canvasKind: string;
  interactionMode: InteractionMode;
  closeOn: CloseOn;
  autoCloseDelay?: number; // ms after selection before auto-close
  defaultConfig: Partial<TConfig>;
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
  minDuration: number; // minutes
  maxDuration: number; // minutes
}

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
// No caller yet, deliberately kept: calendar.tsx currently decides whether
// it has a meeting-picker config with an inline `config?.calendars` truth
// test that silently falls through to the read-only view when the config is
// wrong. This is the guard that check should be, and wiring it is part of
// closing the scenario-validation gap.
export function isMeetingPickerConfig(
  config: CalendarScenarioConfig
): config is MeetingPickerConfig {
  return "calendars" in config && Array.isArray(config.calendars);
}
