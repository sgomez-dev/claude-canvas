---
name: image
description: |
  Image canvas for showing a PNG in a terminal pane, scaled to fit.
  Use to put a screenshot, chart, diagram or rendered plot in front of the user
  instead of describing it or telling them to open a file.
---

# Image Canvas

Show a PNG in a pane, scaled to fit. **View-only by design.**

## When to reach for this

When you have produced or found an image and the alternative is describing
it in prose, or telling the user to go and open a file themselves.

- "Show me the screenshot the test run captured"
- "Display the chart you just generated"
- "What does the failing visual diff look like?"

## Scenario

### `display` (the only scenario)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn image --scenario display --id img-1 --config '{
  "path": "media/screenshot.png",
  "title": "Playwright failure"
}'
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait img-1
```

## Config

| Field | Required | Meaning |
|---|---|---|
| `path` | one of | PNG file on the machine hosting the terminal. |
| `data` | one of | Base64-encoded PNG bytes, for when there is no shared filesystem. |
| `title` | no | Heading. Costs one row, taken from the image rather than the pane. |
| `background` | no | `#rrggbb` that transparent pixels resolve to. Defaults to black. |

The footer names the source dimensions and, on a protocol tier, which
protocol painted it -- when an image renders wrong, that is the first thing
worth knowing.

Give **exactly one** of `path` and `data`. Both set is rejected rather than
one silently winning, because then the other's typo would be invisible.

## What it renders, and what it does not

**PNG only, 8-bit RGB or RGBA, non-interlaced.** Palette, greyscale,
greyscale-with-alpha, 16-bit and interlaced files are refused with the
format named, so you know what to convert. There is no JPEG, GIF or WebP
support. Images above 16 megapixels are refused before anything is
allocated.

## Resolution depends on the terminal, and you do not have to care

The tier is detected for you and the config is identical either way.

| Tier | Terminals | What you get |
|---|---|---|
| `kitty` | kitty, Ghostty | Full resolution. The terminal decodes the PNG. |
| `iterm2` | iTerm2 | Full resolution, via inline images. |
| `sixel` | WezTerm, foot, Windows Terminal, xterm | Full resolution, 256 colours. |
| `halfblocks` | everything else, including the default macOS Terminal | Roughly `columns × 2·rows` pixels. |

`halfblocks` is the **baseline, not a failure**: `▀` painted with a
foreground and a background colour puts two vertically stacked pixels in one
character cell, so the image is box-averaged down to the pane. It is a real
image and it works anywhere 24-bit colour does -- but it is genuinely low
resolution. Fine text in a screenshot will not be readable there; a chart, a
diagram, a UI layout or a visual diff will be.

Inside tmux the escapes are wrapped in a DCS passthrough, which needs
`allow-passthrough` on (tmux 3.3+):

```bash
tmux set -g allow-passthrough on
```

Without it a protocol tier shows nothing at all. `halfblocks` is unaffected,
because it is ordinary text.

Two overrides, for when detection is wrong:

- `CANVAS_GRAPHICS=kitty|iterm2|sixel|halfblocks|none` forces the tier. Set
  it to `halfblocks` if a protocol tier shows garbage.
- `CANVAS_CELL_PIXELS=WxH` tells the Sixel encoder how many pixels a cell
  is. It cannot be detected without interrogating the terminal, so it is
  assumed to be 8x16 -- deliberately small, so an image under-fills its rows
  rather than overflowing them and pushing the footer off screen. Set it if
  your Sixel images look smaller than the space reserved for them.

A misspelled value for either is reported as an error rather than ignored.

## Result

**There is no `selected` outcome.** `image` is view-only: the user looks,
then closes, and `wait` returns `{"status":"cancelled","reason":"escape"}`.
That is the normal, successful end of an image's life, not a failure.

`get <id> <key>` answers `null` for every key: `image` exposes no readable
state.

## Keys

`Esc` closes. Nothing else -- the image is scaled to the pane, so there is
nothing to scroll or pan. The footer shows the source dimensions.

## Errors

A config problem and an unreadable file are reported the same way, through
one error message that names the source:

```
image: could not read /tmp/chart.png: ENOENT: no such file or directory
image: could not read inline data: not a PNG file
```

An error is a **terminal outcome**: the canvas produces exactly one, so once
a config has been rejected, pushing a corrected one renders it on screen but
reports nothing further. Get the config right the first time, or spawn a new
canvas.

## Updating it in place

`update <id> --config '<json>'` replaces the image in a running canvas --
useful for a canvas you keep open while re-running a build that regenerates
a chart. There is no interaction state to reset.
