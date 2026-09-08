export type RegionKind = "table" | "picker" | "form" | "diff" | "tree" | "text";

export interface DashboardRegion {
  /** Unique within the canvas, and what an outcome reports back. */
  id: string;
  title?: string;
  kind: RegionKind;
  /**
   * Fixed height in rows. Regions that omit it share whatever is left, so a
   * dashboard of all-omitted regions divides the pane evenly.
   */
  rows?: number;
  /** That region kind's own config. Validated by that kind's validator. */
  config: unknown;
}

export interface DashboardConfig {
  title?: string;
  regions: DashboardRegion[];
}

/**
 * A composed canvas still produces exactly one outcome, and it says which
 * region produced it. Without `regionId` a controller receiving
 * `{"selectedIds":["x"]}` from a dashboard with three pickers could not tell
 * which question had been answered.
 */
export interface DashboardResult {
  regionId: string;
  result: unknown;
}
