import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { TreeNode, TreeResult } from "./types";

export interface TreeViewProps {
  nodes: TreeNode[];
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

  const visibleCount = Math.max(1, budget - CHROME_ROWS - (prompt ? 1 : 0));
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
          {rows.length > visibleCount
            ? `${windowStart + 1}-${windowStart + windowRows.length} of ${rows.length}  `
            : ""}
          ↑/↓: move  ←/→: fold  Enter: pick  Esc: cancel
        </Text>
      </Box>
    </Box>
  );
}
