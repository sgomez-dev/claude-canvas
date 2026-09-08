---
name: form
description: |
  Form canvas for filling in a small set of structured fields and submitting them as one result.
  Use when you need several related answers at once — a bug report, a config block, a release note —
  instead of asking a series of separate questions.
---

# Form Canvas

Fill in a small set of structured fields and submit them as one result.

## When to reach for this

When you need more than one answer and the answers belong together. Asking
five questions in five turns is worse for the user than one pane they can
Tab through and submit once.

- "Fill in the details for the bug report"
- "What should the release notes say, and which severity?"
- "Give me the values for this config block"

## Scenario

### `fill` (the only scenario)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn form --scenario fill --id form-1 --config '{
  "title": "Report a bug",
  "fields": [
    {"id": "summary",    "type": "text",     "label": "Summary", "required": true},
    {"id": "details",    "type": "textarea", "label": "Details", "placeholder": "What happened?"},
    {"id": "severity",   "type": "select",   "label": "Severity",
     "options": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}]},
    {"id": "regression", "type": "checkbox", "label": "Is it a regression?"},
    {"id": "count",      "type": "number",   "label": "Occurrences", "min": 1, "max": 10}
  ]
}'
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts wait form-1
```

## Field types

| Type | Input | Result type |
|---|---|---|
| `text` | Typed characters, Backspace | `string` |
| `textarea` | As `text`; `Enter` inserts a newline, so `Tab` is the only way out | `string` |
| `select` | `←`/`→` cycle the options | `string` (the chosen `value`) |
| `checkbox` | `Space` toggles | `boolean` |
| `number` | Digits only; `-` allowed when `min` is negative or absent | `number` |

`required` applies to `text`, `textarea`, `select` and `number`. `checkbox`
has no `required` variant: an unchecked box is a valid, meaningful `false`,
never a missing value.

A `number` field clamps to `min`/`max` **when it loses focus**, not on every
keystroke, so "1" on the way to "12" is not clamped mid-entry.

## Result

`wait` returns `{"status":"selected","data":{"values":{...}}}` with one entry
per field id, typed per the table above. Escape gives
`{"status":"cancelled","reason":"escape"}`.

## Validation

**Submitting with a `required` field still empty does not close the canvas.**
Every missing field is marked `<- required` in place and the form stays open.
A form primitive that can silently submit incomplete required data is worse
than one that refuses to, so there is no way to force an incomplete submit.

A `number` field holding something unparseable (a lone `-`) is treated as
empty, not as a number — it will never arrive as `null`.

## Keys

`Tab`/`Shift+Tab` move between fields and onto the Submit button, from any
field type. `Enter` on Submit submits. `Esc` cancels.

## Config errors

Reported, with the message rendered instead of an unusable form: `fields` not
an array or empty, a field missing `id` or `label`, an unsupported `type`,
duplicate field ids, or a `select` whose `options` are missing, empty or
malformed.

A config error reaches you as
`{"status":"error","message":"..."}` from `wait`, even though it is reported
before you connect — see `canvas` skill, "Outcomes cannot be missed".
