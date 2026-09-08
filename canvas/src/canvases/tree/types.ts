export interface TreeNode {
  /**
   * Unique across the whole tree, and what a selection reports back. Stable
   * across a refresh is the caller's job: a dashboard that re-pushes its
   * config keeps the same ids so a collapse state can survive it.
   */
  id: string;
  label: string;
  /**
   * Short annotation rendered dim after the label -- a git status letter, a
   * failure count, a size. Kept as a plain string so the caller formats it;
   * the view has no opinion about what a tree is a tree of.
   */
  badge?: string;
  children?: TreeNode[];
  /** Initially collapsed. Only meaningful on a node with children. */
  collapsed?: boolean;
}

export interface TreeConfig {
  title?: string;
  prompt?: string;
  nodes: TreeNode[];
}

export interface TreeResult {
  selectedId: string;
  /** Labels from the root down to the selection, for context. */
  path: string[];
}
