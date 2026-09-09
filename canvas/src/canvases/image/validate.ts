import type { ImageConfig } from "./types";
import { DEFAULT_BACKGROUND, type RGB } from "../halfblocks";

export type ImageSource =
  | { kind: "path"; path: string }
  | { kind: "data"; bytes: Uint8Array };

export interface ValidatedImage {
  source: ImageSource | null;
  title: string | undefined;
  background: RGB;
  error: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function fail(error: string): ValidatedImage {
  return { source: null, title: undefined, background: DEFAULT_BACKGROUND, error };
}

/**
 * Checks an image config without touching the filesystem.
 *
 * A pure function, like every other validator here, so a composing canvas
 * reports a bad region config exactly as the shell reports a bad canvas
 * config. That is why a `path` is only shape-checked: whether the file
 * exists, is readable and is really a PNG can only be answered by reading
 * it, which is the shell's job and produces its own error. Base64 IS
 * decoded here -- that needs no I/O, and a payload that is not base64 at
 * all is a config error rather than a decode failure.
 */
export function validateImage(config: ImageConfig | undefined): ValidatedImage {
  const path: unknown = config?.path;
  const data: unknown = config?.data;

  if (path !== undefined && data !== undefined) {
    return fail("image config: give either 'path' or 'data', not both");
  }
  if (path === undefined && data === undefined) {
    return fail("image config: needs a 'path' or 'data'");
  }

  const title: unknown = config?.title;
  if (title !== undefined && typeof title !== "string") {
    return fail("image config: 'title' must be a string");
  }

  const rawBackground: unknown = config?.background;
  let background = DEFAULT_BACKGROUND;
  if (rawBackground !== undefined) {
    if (typeof rawBackground !== "string" || !HEX.test(rawBackground)) {
      return fail(
        `image config: 'background' must be a hex colour like "#1e2a34", got ${JSON.stringify(rawBackground)}`
      );
    }
    background = {
      r: parseInt(rawBackground.slice(1, 3), 16),
      g: parseInt(rawBackground.slice(3, 5), 16),
      b: parseInt(rawBackground.slice(5, 7), 16),
    };
  }

  if (path !== undefined) {
    if (typeof path !== "string" || path.length === 0) {
      return fail("image config: 'path' must be a non-empty string");
    }
    return { source: { kind: "path", path }, title, background, error: null };
  }

  if (typeof data !== "string" || data.length === 0) {
    return fail("image config: 'data' must be a non-empty base64 string");
  }
  let bytes: Uint8Array;
  try {
    // Buffer.from is lenient -- it skips characters outside the base64
    // alphabet rather than throwing -- so a payload of pure garbage decodes
    // to a short buffer instead of failing. Only a fully empty result is
    // rejected here, and that is deliberate rather than a gap: anything
    // that survives is handed to the decoder, which checks the 8-byte PNG
    // signature first and refuses with "not a PNG file" naming the source.
    // Strict base64 re-validation would buy a slightly earlier error for
    // the same input and is the sort of check that drifts from the decoder
    // it duplicates.
    const buf = Buffer.from(data, "base64");
    if (buf.length === 0) {
      return fail("image config: 'data' is not valid base64");
    }
    bytes = new Uint8Array(buf);
  } catch {
    return fail("image config: 'data' is not valid base64");
  }
  return { source: { kind: "data", bytes }, title, background, error: null };
}
