import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { MeetingPickerView } from "./calendar/scenarios/meeting-picker-view";
import {
  isMeetingPickerConfig,
  meetingPickerConfigError,
  displayConfigError,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  type MeetingPickerConfig,
} from "../scenarios/types";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { formatTime } from "./format";
// Re-exported because this module's public surface has always included it;
// the definition now lives in one place instead of being copied here
// byte-for-byte.
export type { CalendarEvent } from "./calendar/types";
import type { CalendarEvent } from "./calendar/types";
import {
  allDayRowCount,
  formatDayName,
  formatDayNumber,
  formatHour,
  formatMonthYear,
  getAmPm,
  getWeekDays,
  isAllDayEvent,
  isSameDay,
} from "./calendar/dates";
import { CalendarDisplayView } from "./calendar/display-view";

export interface CalendarConfig {
  title?: string;
  events?: Array<{
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    color?: string;
    allDay?: boolean;
  }>;
  // Meeting picker config (when scenario is "meeting-picker")
  calendars?: MeetingPickerConfig["calendars"];
  slotGranularity?: MeetingPickerConfig["slotGranularity"];
  startHour?: number;
  endHour?: number;
}

interface Props {
  id: string;
  config?: CalendarConfig;
  enabled?: boolean;
  scenario?: string;
}

const START_HOUR = 6;
const END_HOUR = 22;


// Thin router: calls no hooks of its own, so switching scenarios never
// changes which hooks run for a given mount (a rules-of-hooks violation the
// previous single-component version had, harmless only because the scenario
// never actually changes mid-mount). Each branch mounts a different
// component, and that component owns its own hooks.
export function Calendar({ id, config, enabled = false, scenario = "display" }: Props) {
  if (scenario === "meeting-picker") {
    // The check used to be an inline `config?.calendars` truth test whose
    // else-branch fell through to the read-only display. A caller who asked
    // for a meeting picker and got a calendar they could not pick from was
    // told nothing at all: no error anywhere, and `wait` answered `pending`
    // 55 s later. This is the type guard that check should always have
    // been, and a bad config is now reported like every other primitive's.
    if (!config || !isMeetingPickerConfig(config)) {
      // Report the SPECIFIC thing that's wrong -- calendars, slotGranularity,
      // or (once wired to actually be respected) startHour/endHour each get
      // their own distinct, actionable message.
      const message = !config
        ? "calendar config: scenario 'meeting-picker' needs a non-empty 'calendars' array"
        : meetingPickerConfigError(config) ??
          // isMeetingPickerConfig and meetingPickerConfigError agree by
          // construction (the former IS the latter's null-check), so this
          // is unreachable -- kept only so `message` always has a string.
          "calendar config: invalid 'meeting-picker' config";
      return (
        <CalendarConfigError
          id={id}
          scenario={scenario}
          enabled={enabled}
          message={message}
        />
      );
    }
    const pickerConfig: MeetingPickerConfig = {
      calendars: config.calendars,
      slotGranularity: config.slotGranularity || 30,
      title: config.title,
      startHour: config.startHour ?? DEFAULT_START_HOUR,
      endHour: config.endHour ?? DEFAULT_END_HOUR,
    };
    return <MeetingPickerView id={id} config={pickerConfig} enabled={enabled} />;
  }

  // Same gap meeting-picker had before the check above: 'display' read
  // config?.startHour/endHour with no validation at all, so an inverted,
  // equal, negative, or fractional pair silently produced a broken grid
  // (zero/negative totalSlots, garbled hour labels) with no error ever
  // reported. Validated here, before CalendarDisplay mounts, so a bad value
  // never reaches the totalSlots/slotHeights math -- same "validate before
  // render" placement as the meeting-picker check above.
  const displayError = config ? displayConfigError(config) : null;
  if (displayError) {
    return (
      <CalendarConfigError
        id={id}
        scenario={scenario}
        enabled={enabled}
        message={displayError}
      />
    );
  }

  return <CalendarDisplay id={id} config={config} enabled={enabled} scenario={scenario} />;
}

interface CalendarConfigErrorProps {
  id: string;
  scenario: string;
  enabled: boolean;
  message: string;
}

// Owns a server so the error actually reaches the controller, and so the
// pane is still closable and discoverable like any other canvas.
function CalendarConfigError({ id, scenario, enabled, message }: CalendarConfigErrorProps) {
  const ipc = useCanvasServer({ id, kind: "calendar", scenario, enabled, onClose: () => {} });
  const sentRef = useRef(false);
  useEffect(() => {
    if (ipc.isConnected && !sentRef.current) {
      sentRef.current = true;
      ipc.sendError(message);
    }
  }, [ipc.isConnected, ipc.sendError, message]);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
      <Text color="red">{message}</Text>
    </Box>
  );
}

interface CalendarDisplayProps {
  id: string;
  config?: CalendarConfig;
  enabled: boolean;
  scenario: string;
}

function CalendarDisplay({ id, config, enabled, scenario }: CalendarDisplayProps) {
  // This scenario had no server at all: it started no IPC, wrote no
  // registry record, and so could not be listed, read or closed. `close`
  // answered "no canvas <id>" for a pane that was sitting right there --
  // against the lifecycle design, which requires closing to be an IPC
  // request because killing the process leaves a zombie pane on Windows.
  const ipc = useCanvasServer({
    id,
    kind: "calendar",
    scenario,
    enabled,
    onClose: () => {},
    onGet: (key) => (key === "config" ? (config ?? null) : null),
  });
  const { exit } = useApp();

  // Escape and `q` are the shell's, and only the shell's. The view moves
  // around the grid; ending the canvas produces its single outcome, and
  // that cannot be delegated to something that does not own it.
  useInput((input, key) => {
    if (input !== "q" && !key.escape) return;
    // View-only by design: there is no "selected" outcome, so a normal
    // quit always reports cancelled -- same pattern table/picker/form/
    // diff/document all use. Without this, the registry record was
    // deleted with no outcome recorded, and a `wait` issued after a
    // normal `q` quit got "no canvas <id>" (an error) instead of the
    // "cancelled" a view-only scenario's own docs promise.
    ipc.sendCancelled("User quit");
    exit();
  });

  return <CalendarDisplayView config={config} focused />;
}
