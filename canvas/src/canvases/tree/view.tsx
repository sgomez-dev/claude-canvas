import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { wrappedLineCount } from "../width";
import type { TreeNode, TreeResult } from "./types";

export interface TreeViewProps {
  nodes: TreeNode[];
  /** Terminal width, for measuring whether the footer hint wraps. */
  columns?: number;
  title?: string;
  prompt?: string;
  /** Total rows this view may paint into; it subtracts its own chrome. */
  budget: number;
  focused: boolean;
  onSubmit(result: TreeResult): void;
}

// Two border rows, the title, a blank line and the footer hint. The prompt
// adds one more when present.
const CHROME_ROWS = 5;
// Two border columns plus one column of padding on each side.
const HORIZONTAL_CHROME = 4;
// Rendered from this constant, and measured from it: they used to be
// separate literals in the other four views, so editing the visible hint
// silently mismeasured its own wrapped height.
const FOOTER_HINT = "↑/↓: move  ←/→: fold  Enter: pick  Esc: cancel";

interface Row {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  /** Labels from the root down to and including this node. */
  path: string[];
}

/**
 * Flattens the tree into the rows currently on screen, which is where the
 * collapse state actually takes effect: a collapsed node contributes itself
 * and none of its descendants.
 */
function flatten(nodes: TreeNode[], collapsed: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (list: TreeNode[], depth: number, prefix: string[]): void => {
    for (const node of list) {
      const children = node.children ?? [];
      const path = [...prefix, node.label];
      out.push({ node, depth, hasChildren: children.length > 0, path });
      if (children.length > 0 && !collapsed.has(node.id)) {
        walk(children, depth + 1, path);
      }
    }
  };
  walk(nodes, 0, []);
  return out;
}

/**
 * The dynamic position-indicator prefix the footer actually renders (e.g.
 * "12-19 of 40  "), or "" when the list fits without windowing at all --
 * mirrors picker/view.tsx's `positionPrefix`, which is the reference for
 * this pattern: the row-budget math has to measure the string that will
 * actually appear, not just the static hint.
 */
function positionPrefix(total: number, cursor: number, visibleCount: number): string {
  if (total <= visibleCount) return "";
  const start = Math.floor(cursor / visibleCount) * visibleCount;
  const visibleLen = Math.min(visibleCount, total - start);
  return `${start + 1}-${start + visibleLen} of ${total}  `;
}

function initialCollapsed(nodes: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.collapsed && (node.children?.length ?? 0) > 0) out.add(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * A navigable tree with collapse and expand, knowing nothing about IPC or
 * outcomes.
 *
 * The one thing on the roadmap's dashboard list that no existing primitive
 * covers: a `text` region renders a tree badly (no collapsing, no
 * navigation) and `picker` flattens away the structure that makes a tree
 * worth showing.
 *
 * Escape belongs to the canvas shell -- see picker/view.tsx.
 */
export function TreeView({
  nodes,
  title,
  prompt,
  budget,
  columns = 80,
  focused,
  onSubmit,
}: TreeViewProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed(nodes));
  const rows = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed]);

  const [cursor, setCursor] = useState(0);
  // Mirrors `cursor` synchronously into a ref, for the same reason every
  // other view does: useInput's handler is re-registered in a passive effect
  // that lags a state commit, so reading the closed-over `cursor` inside the
  // handler can observe a stale value when two keystrokes arrive close
  // together. See picker/view.tsx for the full reasoning.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Collapsing changes how many rows exist, so a cursor that was valid can
  // point past the end. Clamped at read time rather than corrected in an
  // effect, which would cost a render and lag the handler by one keystroke.
  const clamped = Math.min(cursor, Math.max(0, rows.length - 1));

  function move(delta: number) {
    const current = rowsRef.current;
    if (current.length === 0) return;
    const from = Math.min(cursorRef.current, current.length - 1);
    setCursor(Math.max(0, Math.min(current.length - 1, from + delta)));
  }

  function toggle(expand: boolean | undefined) {
    const current = rowsRef.current;
    const row = current[Math.min(cursorRef.current, current.length - 1)];
    if (!row) return;
    if (!row.hasChildren) {
      // Collapsing a leaf moves to its parent instead, which is what every
      // tree UI does and what makes `h` usable for walking back up.
      if (expand === false) {
        for (let i = Math.min(cursorRef.current, current.length - 1) - 1; i >= 0; i--) {
          if (current[i]!.depth < row.depth) {
            setCursor(i);
            return;
          }
        }
      }
      return;
    }
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isCollapsed = next.has(row.node.id);
      const shouldCollapse = expand === undefined ? !isCollapsed : !expand;
      if (shouldCollapse) next.add(row.node.id);
      else next.delete(row.node.id);
      return next;
    });
  }

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        move(-1);
      } else if (key.downArrow || input === "j") {
        move(1);
      } else if (key.leftArrow || input === "h") {
        toggle(false);
      } else if (key.rightArrow || input === "l") {
        toggle(true);
      } else if (input === " ") {
        toggle(undefined);
      } else if (key.return) {
        const current = rowsRef.current;
        const row = current[Math.min(cursorRef.current, current.length - 1)];
        if (row) onSubmit({ selectedId: row.node.id, path: row.path });
      }
    },
    { isActive: focused }
  );

  // At a narrow width the footer hint wraps onto a second line, which
  // CHROME_ROWS's flat "one line of hint" assumption does not account for --
  // the same overflow the other four views were given a budget for, which
  // this one never received because it was written after that wave.
  //
  // The footer that actually renders is a dynamic position prefix (e.g.
  // "12-19 of 40  ") followed by the static hint -- not the hint alone --
  // and the prefix widens the string enough to push it onto an extra
  // wrapped row a hint-only measurement never accounts for. Measuring just
  // FOOTER_HINT reproduced a real overflow at several realistic widths (30
  // nodes, budget 12, at 60/55/50/30 columns: a 13-line frame for a 12-line
  // budget). See picker/view.tsx's identical two-pass reasoning: the
  // prefix's own width depends on `visibleCount`, which this budget
  // calculation produces, so this runs the estimate twice -- once with just
  // the hint to get a candidate `visibleCount`, then measures the ACTUAL
  // footer string that candidate would produce and re-derives `visibleCount`
  // from that.
  const innerWidth = Math.max(1, columns - HORIZONTAL_CHROME);
  let footerRows = wrappedLineCount(FOOTER_HINT, innerWidth);
  let footerOverflow = Math.max(0, footerRows - 1);
  let visibleCount = Math.max(1, budget - CHROME_ROWS - footerOverflow - (prompt ? 1 : 0));
  const actualFooter = positionPrefix(rows.length, clamped, visibleCount) + FOOTER_HINT;
  footerRows = wrappedLineCount(actualFooter, innerWidth);
  footerOverflow = Math.max(0, footerRows - 1);
  visibleCount = Math.max(1, budget - CHROME_ROWS - footerOverflow - (prompt ? 1 : 0));
  const windowStart =
    rows.length <= visibleCount ? 0 : Math.floor(clamped / visibleCount) * visibleCount;
  const windowRows = rows.slice(windowStart, windowStart + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>{title ?? "Tree"}</Text>
      {prompt ? <Text dimColor>{prompt}</Text> : null}
      {windowRows.map((row, visibleIndex) => {
        const i = windowStart + visibleIndex;
        // Gated on `focused` as well as cursor position, same reasoning as
        // picker/view.tsx's isCursor: a composed dashboard can mount this
        // view unfocused, and the row cursor must not keep showing as live
        // in that state.
        const isCursor = i === clamped && focused;
        // The marker carries the state without colour, so a no-color
        // terminal still shows what is collapsed -- the lesson picker's
        // cursor gutter and form's required marker both had to learn.
        const marker = row.hasChildren ? (collapsed.has(row.node.id) ? "▸ " : "▾ ") : "  ";
        return (
          <Text key={row.node.id} color={isCursor ? "cyan" : undefined}>
            {isCursor ? "> " : "  "}
            {"  ".repeat(row.depth)}
            {marker}
            {row.node.label}
            {row.node.badge ? ` ${row.node.badge}` : ""}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {positionPrefix(rows.length, clamped, visibleCount)}
          {FOOTER_HINT}
        </Text>
      </Box>
    </Box>
  );
}
