---
name: diff
description: |
  Diff review canvas: step through a unified diff hunk by hunk and approve or reject each one.
  Use when proposing a multi-part code change so the user can accept some hunks and refuse others,
  instead of accepting or rejecting the whole edit.
---

# Diff Canvas

Review a multi-file unified diff hunk by hunk. Returns a decision per hunk,
so you can apply exactly what the user accepted.

## When to reach for this

Any time you are about to make a change with several independent parts. It
turns "apply all of this or none of it" into a real per-hunk conversation,
and it is the single most frequent interaction anyone has with Claude Code.

- "Show me the changes before you apply them"
- "I want to accept the refactor but not the formatting churn"
- "Walk me through this patch"

Generate the diff first (`git diff`, `git diff --cached`, or a diff of a file
you are about to write), then pass its text as `diffText`.

## Scenario

### `review` (the only scenario)

```bash
git diff > /tmp/change.diff
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn diff --scenario review --id rev-1 --config "$(
  python3 -c 'import json,sys; print(json.dumps({"title":"Proposed refactor","diffText":open("/tmp/change.diff").read()}))'
)"
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts wait rev-1
```

For anything but a tiny diff, prefer `--config-file`: config travels by file
anyway, and Windows caps a command line near 32 KB.

## Config

| Field | Required | Meaning |
|---|---|---|
| `diffText` | **yes** | The complete unified diff. `diff --git` style or plain `diff -u` both parse. |
| `title` | no | Heading. Defaults to "Review Changes". |

## Result

`wait` returns
`{"status":"selected","data":{"decisions":[{"hunkId":"path#0","decision":"approved"},...]}}`.

- `hunkId` is `${newPath}#${indexWithinThatFile}`.
- **A hunk the user never decided on comes back `"rejected"`.** Silence is
  not consent for something that changes real code.
- A binary-only diff submits `{"decisions":[]}` — "reviewed, nothing to
  apply", which is deliberately distinct from the `cancelled` that Escape
  reports.

Apply only the `approved` hunks. Do not assume the set is contiguous.

## Keys

`↑`/`↓` or `j`/`k` move between hunks, crossing file boundaries. `a`
approves, `r` rejects, and a decision can be changed any time before
submitting. `PgUp`/`PgDn` scroll within a long hunk. `Enter` submits, `Esc`
cancels and applies nothing.

## What the parser handles

Multi-file diffs, added/deleted/renamed files, renamed-and-modified in one
block, `\ No newline at end of file`, hunk headers with an implicit length
of 1, and binary files (listed as a label, contributing no hunks).

## Errors

- Empty or whitespace-only `diffText` → "Nothing to review."
- Unparseable text → the parse error is rendered in the pane.
- **The same file appearing twice is rejected.** Hunk ids would collide and
  decisions could not be attributed. If you concatenated several diffs,
  review them one at a time.
- `git diff --no-prefix` is **not** supported: the parser expects the `a/`
  and `b/` prefixes.

A parse error reaches you as `{"status":"error","message":"..."}` from
`wait`, even though it is reported before you connect — see `canvas` skill,
"Outcomes cannot be missed". Note that a parse error is itself the outcome:
if the user then presses Escape you still get the error, not a cancellation.
