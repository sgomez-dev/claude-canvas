import type { TreeConfig, TreeNode } from "./types";

export interface ValidatedTree {
  nodes: TreeNode[];
  error: string | null;
}

/**
 * A tree deep enough to matter is a tree someone built by accident. The cap
 * exists so a malformed config cannot make the flattener recurse until the
 * stack gives out -- a canvas must always be able to exit 0, and a stack
 * overflow is the one failure mode that takes that away.
 */
const MAX_DEPTH = 32;

/**
 * Validates the RAW config before anything walks it.
 *
 * Ids must be unique across the WHOLE tree, not just among siblings: a
 * selection reports one id, and the collapse state is keyed by id, so two
 * nodes sharing one would make both ambiguous.
 */
export function validateTree(config: TreeConfig | undefined): ValidatedTree {
  const raw: unknown = config?.nodes;
  if (!Array.isArray(raw)) {
    return { nodes: [], error: "tree config: 'nodes' must be an array" };
  }
  if (raw.length === 0) {
    return { nodes: [], error: "tree config: 'nodes' must not be empty" };
  }

  const seen = new Set<string>();
  let failure: string | null = null;

  const walk = (list: unknown, depth: number, parentLabel: string): void => {
    if (failure) return;
    if (depth > MAX_DEPTH) {
      failure = `tree config: nesting deeper than ${MAX_DEPTH} levels under ${JSON.stringify(parentLabel)}`;
      return;
    }
    if (!Array.isArray(list)) {
      failure = `tree config: 'children' of ${JSON.stringify(parentLabel)} must be an array`;
      return;
    }
    for (let i = 0; i < list.length; i++) {
      if (failure) return;
      const n: unknown = list[i];
      if (n === null || typeof n !== "object") {
        failure = `tree config: node ${i} under ${JSON.stringify(parentLabel)} is not an object`;
        return;
      }
      const { id, label, children } = n as {
        id?: unknown;
        label?: unknown;
        children?: unknown;
      };
      if (typeof id !== "string" || id.length === 0) {
        failure = `tree config: a node under ${JSON.stringify(parentLabel)} is missing 'id'`;
        return;
      }
      if (typeof label !== "string" || label.length === 0) {
        failure = `tree config: node ${JSON.stringify(id)} is missing 'label'`;
        return;
      }
      if (seen.has(id)) {
        failure = `tree config: duplicate node id ${JSON.stringify(id)}`;
        return;
      }
      seen.add(id);
      if (children !== undefined) walk(children, depth + 1, label);
    }
  };

  walk(raw, 1, "the root");
  if (failure) return { nodes: [], error: failure };
  return { nodes: raw as TreeNode[], error: null };
}
