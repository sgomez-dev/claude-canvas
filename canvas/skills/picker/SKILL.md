---
name: picker
description: |
  Generic picker canvas for choosing one or more options from a list.
  Use whenever the user has to choose between concrete alternatives — a file, a branch,
  a strategy, which items to include — instead of asking them to type an answer.
---

# Picker Canvas

Choose one or more options from a list. The generic form of a selection: no
domain knowledge, no fixed schema.

## When to reach for this

Reach for `picker` any time the next step depends on a choice between things
you can already enumerate. It is almost always better than asking in prose,
because it returns an exact id rather than free text you have to interpret.

- "Which of these files should I refactor?"
- "Pick the branch to rebase onto"
- "Which of these three approaches do you want?"
- "Select the tests to re-run"

## Scenario

### `select` (the only scenario)

Single- or multi-select from one implementation, chosen by `mode`.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn picker --scenario select --id pick-1 --config '{
  "title": "Which files should I refactor?",
  "prompt": "Space toggles, Enter submits",
  "mode": "multi",
  "options": [
    {"id": "src/a.ts", "label": "src/a.ts", "description": "412 lines, 3 exports"},
    {"id": "src/b.ts", "label": "src/b.ts", "description": "88 lines"},
    {"id": "src/c.ts", "label": "src/c.ts", "description": "generated", "disabled": true}
  ]
}'
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts wait pick-1
```

## Config

| Field | Required | Meaning |
|---|---|---|
| `mode` | **yes** | `"single"` or `"multi"`. Omitting it is a config error, not a default. |
| `options` | **yes** | Non-empty array. Each needs a non-empty `id` and `label`. |
| `options[].description` | no | Shown after the label, dimmed. |
| `options[].disabled` | no | Visible but cannot be highlighted or selected. |
| `title` | no | Heading. Defaults to "Choose". |
| `prompt` | no | One dimmed line under the title. |

## Result

`wait` returns `{"status":"selected","data":{"selectedIds":[...]}}` — exactly
one id in `single` mode, the exact set toggled on in `multi` mode (possibly
empty, if the user submitted with nothing checked). Escape gives
`{"status":"cancelled","reason":"escape"}`.

## Keys

`↑`/`↓` or `j`/`k` move. In `single` mode `Enter` selects the highlighted
option and submits. In `multi` mode `Space` toggles and `Enter` submits.
`Esc` cancels. A list longer than the pane pages automatically; the footer
shows the visible range.

## Config errors

These are reported and the canvas renders the message instead of opening an
unusable list: `options` not an array, empty, an option missing `id` or
`label`, duplicate ids, every option disabled, or a missing/unrecognized
`mode`.

**Caveat:** the error is displayed in the pane, but a `wait` that connects
afterwards will not see it — see `canvas` skill, "Known gap: outcomes are
not buffered". Validate configs before spawning.
