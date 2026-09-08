import React from "react";
import { render } from "ink";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Calendar, type CalendarConfig } from "./calendar";
import { Document } from "./document";
import type { DocumentConfig } from "./document/types";
import { FlightCanvas } from "./flight";
import type { FlightConfig } from "./flight/types";
import { Diff } from "./diff";
import type { DiffReviewConfig } from "./diff/types";
import { Picker } from "./picker";
import type { PickerConfig } from "./picker/types";
import { logPath } from "../runtime/paths";

// Defense in depth: cli.ts already rejects an unknown kind before this ever
// runs. But renderCanvas must never be crash-prone on its own, since
// process.exit() here doesn't unwind — if this ran inside a spawned pane,
// the pane's own exit-0 handling would never execute, leaving an
// unremovable pane on Windows. So log (never console.* — it would write
// over the Ink render) and return normally instead.
async function logUnknownKind(id: string, kind: string): Promise<void> {
  try {
    const path = logPath(id);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} unknown canvas kind: ${kind}\n`);
  } catch {
    // Logging must never take the canvas down.
  }
}

// Clear screen and hide cursor
function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
}

// Show cursor on exit
function showCursor() {
  process.stdout.write("\x1b[?25h");
}

export interface RenderOptions {
  scenario?: string;
  enabled: boolean;
}

export async function renderCanvas(
  kind: string,
  id: string,
  config?: unknown,
  options?: RenderOptions
): Promise<void> {
  // Clear screen before rendering
  clearScreen();

  // Ensure cursor is shown on exit
  process.on("exit", showCursor);
  process.on("SIGINT", () => {
    showCursor();
    process.exit();
  });

  switch (kind) {
    case "calendar":
      return renderCalendar(
        id,
        config as CalendarConfig | undefined,
        options
      );
    case "document":
      return renderDocument(
        id,
        config as DocumentConfig | undefined,
        options
      );
    case "flight":
      return renderFlight(
        id,
        config as FlightConfig | undefined,
        options
      );
    case "diff":
      return renderDiff(
        id,
        config as DiffReviewConfig | undefined,
        options
      );
    case "picker":
      return renderPicker(
        id,
        config as PickerConfig | undefined,
        options
      );
    default:
      await logUnknownKind(id, kind);
      return;
  }
}

async function renderCalendar(
  id: string,
  config?: CalendarConfig,
  options?: RenderOptions
): Promise<void> {
  const { waitUntilExit } = render(
    <Calendar
      id={id}
      config={config}
      enabled={options?.enabled ?? false}
      scenario={options?.scenario || "display"}
    />,
    {
      exitOnCtrlC: true,
    }
  );
  await waitUntilExit();
}

async function renderDocument(
  id: string,
  config?: DocumentConfig,
  options?: RenderOptions
): Promise<void> {
  const { waitUntilExit } = render(
    <Document
      id={id}
      config={config}
      enabled={options?.enabled ?? false}
      scenario={options?.scenario || "display"}
    />,
    {
      exitOnCtrlC: true,
    }
  );
  await waitUntilExit();
}

async function renderFlight(
  id: string,
  config?: FlightConfig,
  options?: RenderOptions
): Promise<void> {
  const { waitUntilExit } = render(
    <FlightCanvas
      id={id}
      config={config}
      enabled={options?.enabled ?? false}
      scenario={options?.scenario || "booking"}
    />,
    {
      exitOnCtrlC: true,
    }
  );
  await waitUntilExit();
}

async function renderDiff(
  id: string,
  config?: DiffReviewConfig,
  options?: RenderOptions
): Promise<void> {
  const { waitUntilExit } = render(
    <Diff
      id={id}
      config={config}
      enabled={options?.enabled ?? false}
      scenario={options?.scenario || "review"}
    />,
    {
      exitOnCtrlC: true,
    }
  );
  await waitUntilExit();
}

async function renderPicker(
  id: string,
  config?: PickerConfig,
  options?: RenderOptions
): Promise<void> {
  const { waitUntilExit } = render(
    <Picker
      id={id}
      config={config}
      enabled={options?.enabled ?? false}
      scenario={options?.scenario || "select"}
    />,
    {
      exitOnCtrlC: true,
    }
  );
  await waitUntilExit();
}
