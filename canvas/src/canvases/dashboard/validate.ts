import { validatePicker } from "../picker/validate";
import { validateTable } from "../table/validate";
import { validateForm } from "../form/validate";
import { validateTree } from "../tree/validate";
import { parseDiffConfig } from "../diff/validate";
import type { DashboardConfig, DashboardRegion, RegionKind } from "./types";

const REGION_KINDS: readonly RegionKind[] = ["table", "picker", "form", "diff", "tree", "text"];

export interface ValidatedDashboard {
  regions: DashboardRegion[];
  error: string | null;
}

/**
 * Validates each region's own config with that region kind's own validator.
 *
 * This is the payoff of extracting the validators from the canvas shells in
 * sub-project 1: a bad picker config inside a dashboard is reported with the
 * same message, from the same code, as a bad picker config given to the
 * picker canvas. Re-implementing those checks here would have meant six
 * validators drifting apart from the six they duplicate.
 */
export function validateRegionConfig(region: DashboardRegion): string | null {
  switch (region.kind) {
    case "picker":
      return validatePicker(region.config as never).error;
    case "table":
      return validateTable(region.config as never).error;
    case "form":
      return validateForm(region.config as never).error;
    case "tree":
      return validateTree(region.config as never).error;
    case "diff":
      return parseDiffConfig(region.config as never).error;
    case "text": {
      const text = (region.config as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string") return "text region config: 'text' must be a string";
      return null;
    }
  }
}

export function validateDashboard(config: DashboardConfig | undefined): ValidatedDashboard {
  const raw: unknown = config?.regions;
  if (!Array.isArray(raw)) {
    return { regions: [], error: "dashboard config: 'regions' must be an array" };
  }
  if (raw.length === 0) {
    return { regions: [], error: "dashboard config: 'regions' must not be empty" };
  }

  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i];
    if (r === null || typeof r !== "object") {
      return { regions: [], error: `dashboard config: regions[${i}] is not an object` };
    }
    const { id, kind, rows } = r as { id?: unknown; kind?: unknown; rows?: unknown };
    if (typeof id !== "string" || id.length === 0) {
      return { regions: [], error: `dashboard config: regions[${i}] is missing 'id'` };
    }
    if (seen.has(id)) {
      // Two regions sharing an id would make the outcome's `regionId`
      // ambiguous, which is the one field that makes a composed outcome
      // readable at all.
      return { regions: [], error: `dashboard config: duplicate region id ${JSON.stringify(id)}` };
    }
    seen.add(id);
    if (typeof kind !== "string" || !REGION_KINDS.includes(kind as RegionKind)) {
      return {
        regions: [],
        error:
          `dashboard config: region ${JSON.stringify(id)} has unsupported kind ${JSON.stringify(kind)}. ` +
          `Expected one of: ${REGION_KINDS.join(", ")}.`,
      };
    }
    if (rows !== undefined && (typeof rows !== "number" || !Number.isInteger(rows) || rows < 3)) {
      // Below three rows a bordered region has no room for content at all.
      return {
        regions: [],
        error: `dashboard config: region ${JSON.stringify(id)} has an invalid 'rows' (must be an integer >= 3)`,
      };
    }
    const regionError = validateRegionConfig(r as DashboardRegion);
    if (regionError) {
      return { regions: [], error: `dashboard config: region ${JSON.stringify(id)}: ${regionError}` };
    }
  }

  return { regions: raw as DashboardRegion[], error: null };
}
