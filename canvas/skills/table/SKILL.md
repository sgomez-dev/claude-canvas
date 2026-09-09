---
name: table
description: |
  Table canvas for displaying tabular data with a fixed header and a scrolling body.
  Use to show a set of rows the user should read — test results, dependency versions, query output —
  rather than dumping a wide table into the conversation where it wraps.
---

# Table Canvas

Display tabular data with a fixed header and a scrolling body. **View-only
by design.**

## When to reach for this

When you have rows the user needs to read and the terminal conversation would
mangle them. A pane keeps the header visible while they scroll, and keeps
columns aligned.

- "Show me the failing tests"
- "List the outdated dependencies with their versions"
- "Display the query results"

## Scenario

### `display` (the only scenario)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn table --scenario display --id tbl-1 --config '{
  "title": "Outdated dependencies",
  "columns": [
    {"key": "name",    "label": "Package", "width": 24},
    {"key": "current", "label": "Current", "width": 10},
    {"key": "latest",  "label": "Latest",  "width": 10},
    {"key": "note",    "label": "Note"}
  ],
  "rows": [
    {"name": "ink", "current": "6.6.0", "latest": "6.8.0", "note": "minor"},
    {"name": "commander", "current": "14.0.2", "latest": "14.0.3", "note": "patch"}
  ]
}'
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait tbl-1
```

## Config

| Field | Required | Meaning |
|---|---|---|
| `columns` | **yes** | Non-empty array. Each needs a non-empty `key` and a `label`. |
| `columns[].width` | no | Integer >= 1. Omitted means auto: the longest value present, capped at 40. |
| `rows` | no | Array of `{[key]: string}`. Omitted or empty renders an explicit "No data." state. |
| `title` | no | Heading. Defaults to "Table". |

All cell values must be strings — format numbers and dates yourself, so the
rendering is yours to control.

Content wider than a column is truncated with an ellipsis, never wrapped:
wrapping would break row alignment.

## Result

**There is no `selected` outcome.** `table` is view-only: the user reads,
then closes, and `wait` returns
`{"status":"cancelled","reason":"escape"}`. That is the normal, successful
end of a table's life, not a failure.

If you need the user to pick a row, compose this with `picker` rather than
expecting a selection here — that is a deliberate design decision, so
selection logic lives in exactly one primitive.

`get <id> <key>` answers `null` for every key: `table` exposes no readable
state.

## Keys

`↑`/`↓` or `j`/`k` scroll a row, `PgUp`/`PgDn` a window. `Esc` closes. The
footer shows the visible range whenever the data does not fit.

## Wide characters

Column widths are measured in display columns, so CJK, fullwidth forms,
emoji and combining marks all align correctly -- a cell holding `日本語`
counts as 6 columns, not 3, and a family emoji as 2, not 11. This includes
the common double-width status glyphs in the Miscellaneous Symbols,
Dingbats, and Miscellaneous Symbols and Arrows blocks -- things like
`✅`/`❌`/`⭐`/`⌚`/`☑`, the fast-forward/rewind/alarm-clock/hourglass glyphs
(`⏩⏪⏫⏬⏰⏳`), `♿`, and `◽`/`◾` -- so a status column using any of them
aligns correctly too.

That coverage is a practical, terminal-observed subset of those blocks
rather than every code point in them, and the two kinds of gap that leaves
are different, not the same thing. Some are genuine exceptions: a handful
of symbols in the same blocks are default-TEXT-presentation and are
correctly excluded on purpose -- `⚠` is the standing example, which stays
single-width unless followed by an emoji presentation selector (`U+FE0F`),
matching how most terminals actually render it, and `◻`/`◼` (the larger
"medium square", unlike `◽`/`◾`'s "medium small square" above) are the
same kind of exception. Others are simply not yet covered: this table
targets the glyphs most likely to show up in a generated status table
rather than the full Emoji_Presentation set, so an emoji this list hasn't
gotten to yet can still measure narrow even though a terminal renders it
wide -- that is a coverage gap to file, not a deliberate text-presentation
call like `⚠`'s.

The one case that can still look wrong is a ZWJ sequence (a family or
profession emoji) in a terminal that does not support ZWJ: it draws the
component emoji side by side and occupies more room than any measurement
would predict. Single-codepoint emoji and CJK are unaffected.

## Updating it in place

`update <id> --config '<json>'` replaces the config of a running canvas.
The interaction state is **reset**: a pushed config is a new question, so
the scroll returns to the top. This is the primitive most likely to want
an update -- refreshing rows in place is the obvious use for server-push.
