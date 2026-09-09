---
name: dashboard
description: |
  Composed canvas: several primitive views — tables, pickers, trees, forms, diffs, text — in one pane.
  Use to show the state of a project at a glance (git status, test results, TODOs, changed files)
  and, optionally, let the user act on one of them.
---

# Dashboard Canvas

Several primitive views in one pane, each in its own region. The user Tabs
between the interactive ones, and if they act on one, the outcome tells you
**which region** answered.

## When to reach for this

When the answer to "how is this project doing?" needs more than one shape at
once, or when a choice only makes sense next to its context.

- "Show me the state of the repo" — git status, failing tests, changed files
- "What should I work on?" — a TODO picker beside the test results that
  motivate it
- "Walk me through this change" — a file tree beside the diff of the
  selected file

## Important: you gather the data, the canvas renders it

**The dashboard runs nothing.** No `git`, no test suite, no file walking. You
gather, you build the config, the canvas renders it. Refresh by pushing a new
config with `update`.

That is deliberate: a canvas that shelled out would need a permissions
story, a refresh story and an error story per command, and would be the only
thing here that executes arbitrary commands.

## Scenario

### `display` (the only scenario)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spawn dashboard --scenario display --id dash-1 \
  --config-file /tmp/dash.json
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait dash-1
```

Use `--config-file` rather than `--config`: a dashboard config is the
largest of any canvas, and Windows caps a command line near 32 KB.

```json
{
  "title": "claude-canvas",
  "regions": [
    { "id": "git", "kind": "text", "title": "Branch", "rows": 4,
      "config": { "text": "main, 3 files changed" } },
    { "id": "tests", "kind": "table", "title": "Failing tests", "rows": 8,
      "config": { "columns": [{ "key": "name", "label": "Test", "width": 30 },
                              { "key": "why", "label": "Reason" }],
                  "rows": [{ "name": "protocol > oversized", "why": "timeout" }] } },
    { "id": "files", "kind": "tree", "title": "Changed", "rows": 10,
      "config": { "nodes": [{ "id": "src", "label": "src/", "children": [
                    { "id": "src/cli.ts", "label": "cli.ts", "badge": "M" }] }] } },
    { "id": "next", "kind": "picker", "title": "What next?",
      "config": { "mode": "single",
                  "options": [{ "id": "fix", "label": "Fix the timeout" },
                              { "id": "skip", "label": "Skip for now" }] } }
  ]
}
```

## Region kinds

| Kind | Interactive | Config | Result |
|---|---|---|---|
| `text` | no | `{ "text": "..." }` | — |
| `table` | scrolls | the `table` canvas's config | — |
| `tree` | folds, picks | `{ "nodes": [...] }` | `{ selectedId, path }` |
| `picker` | picks | the `picker` canvas's config | `{ selectedIds }` |
| `form` | fills | the `form` canvas's config | `{ values }` |
| `diff` | reviews | the `diff` canvas's config | `{ decisions }` |

Each region's config is validated by that kind's own validator, so a bad
picker config inside a dashboard is reported with the same message as a bad
picker config given to the `picker` canvas — prefixed with which region it
was.

## Heights

`rows` fixes a region's height. Regions that omit it share whatever is left,
so a dashboard of all-omitted regions divides the pane evenly. Minimum 3, and
a region needs roughly **6 rows of chrome plus its content** — a `table`
region with `rows: 7` shows one data row. Give the region you want read the
most rows.

## Result

`wait` returns
`{"status":"selected","data":{"regionId":"...","result":{...}}}`. The
`result` is whatever that region kind returns, per the table above.

Only one region can answer: the first outcome wins and closes the pane.
`Esc` gives `{"status":"cancelled","reason":"escape"}` and closes the whole
dashboard, not a region.

A dashboard of only `text` and `table` regions can never produce
`selected` — it is a display, and `cancelled` is how it ends successfully.

## Keys

`Home` / `End` move between the interactive regions, skipping `text`. This
is deliberately **not** `Tab`/`Shift+Tab`: a composed `form` region binds
Tab itself, to move between its own fields, and Ink calls every active key
handler for the same keystroke rather than routing it to one -- so if the
dashboard also bound Tab, a single press inside a focused form would both
advance its field cursor and hand focus to a different region, and there
would be no way to move within a multi-field form without also leaving it
early. `Shift+Tab` was considered too and rejected for the same reason:
`form` already binds it for backward field navigation.

Besides Home/End, the focused region gets every other key, so `↑`/`↓`,
`Enter`, `Space`, `Tab`/`Shift+Tab` and `←`/`→` mean whatever that region
kind says they mean -- a focused `form`'s own Tab moves within its fields
and never changes which region the dashboard considers focused. `Esc`
always closes.

## Refresh

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/dist/cli.js update dash-1 --config-file /tmp/dash2.json
```

Re-gather, re-push. Note that a pushed config **resets the interaction
state** — folds, cursors, half-filled forms — because a new config is a new
question.
