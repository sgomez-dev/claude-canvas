/**
 * An image canvas config.
 *
 * Exactly one source. `path` is the normal one; `data` exists because a
 * controller and a canvas do not always share a filesystem -- the canvas
 * runs in a pane on the machine hosting the terminal, which need not be
 * where the caller built the payload.
 */
/**
 * Shared by `view.tsx` and `graphics-view.tsx`, which both render it in
 * their footer -- kept as one constant, imported by both, rather than two
 * independent literals that could drift the way the other five primitive
 * views' footer hints did before that was fixed.
 */
export const FOOTER_HINT = "Esc: close";

export interface ImageConfig {
  /** PNG file on the canvas host's filesystem. */
  path?: string;
  /** Base64-encoded PNG bytes, for when there is no shared filesystem. */
  data?: string;
  title?: string;
  /**
   * What transparent pixels resolve to, as `#rrggbb`. A terminal cannot
   * report its own background colour, so the caller is the only one who
   * might know. Defaults to black.
   */
  background?: string;
}
