---
name: document
description: |
  Document canvas for displaying and editing markdown content.
  Use when showing documents, emails, or when users need to select text for editing.
---

# Document Canvas

Display markdown documents with optional text selection.

## Example Prompts

Try asking Claude:

- "Draft an email to the marketing team about the Q1 product launch"
- "Help me edit this blog post — show it so I can highlight the parts to revise"
- "Write a project proposal and let me review it"
- "Show me the README so I can select sections to update"
- "Compose a response to this customer complaint"

## Scenarios

### `display` (default)
Read-only document view with markdown rendering. User can scroll but cannot select text.

```bash
bun run src/cli.ts show document --scenario display --config-file cfg.json
# cfg.json:
# {
#   "content": "# Hello World\n\nThis is **markdown** content.",
#   "title": "My Document"
# }
```

### `edit`
Interactive document view with text selection. User can click and drag to select text, which is sent via IPC in real-time.

- Renders markdown with syntax highlighting (headers, bold, italic, code, links, lists, blockquotes)
- Diff highlighting: green background for additions, red for deletions
- Click and drag to select text
- Selection automatically sent via IPC

```bash
bun run src/cli.ts spawn document --scenario edit --config '{
  "content": "# My Blog Post\n\nThis is the **introduction** to my post.\n\n## Section One\n\n- Point one\n- Point two",
  "title": "Blog Post Draft",
}'
```

### `email-preview`
Specialized view for email content display.

```bash
bun run src/cli.ts show document --scenario email-preview --config-file cfg.json
# cfg.json:
# {
#   "content": "Dear Team,\n\nPlease review the attached document.\n\nBest regards,\nAlice",
#   "title": "RE: Project Update"
# }
```

## Configuration

```typescript
interface DocumentConfig {
  content: string;        // Markdown content
  title?: string;         // Document title (shown in header)
  readOnly?: boolean;     // Disable selection (default: false for edit)
}

interface DocumentDiff {
  startOffset: number;    // Character offset in content
  endOffset: number;
  type: "add" | "delete";
}
```

## Markdown Rendering

Supported markdown features:
- **Headers** (`# H1`, `## H2`, etc.)
- **Bold** (`**text**`)
- **Italic** (`*text*`)
- **Code** (`` `inline` `` and fenced blocks)
- **Links** (`[text](url)`)
- **Lists** (`-` or `*` bullets)
- **Blockquotes** (`>`)

## Selection Result

```typescript
interface DocumentSelection {
  selectedText: string;   // The selected text
  startOffset: number;    // Start character offset
  endOffset: number;      // End character offset
  startLine: number;      // Line number (1-based)
  endLine: number;
  startColumn: number;    // Column in start line
  endColumn: number;
}
```

## Controls

- **Mouse click and drag**: Select text (edit scenario)
- `↑/↓` or scroll: Navigate document
- `q` or `Esc`: Close/cancel

## CLI Usage

```bash
# Read-only view
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts show document --scenario display --config-file cfg.json

# Interactive editing with selection
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts spawn document --scenario edit \
  --id doc-1 --config '{
    "content": "# My Document\n\nSelect some **text** here.",
    "title": "Edit Mode",
  }'

# Read the current selection on demand — this is pull-only, not push-based.
# The document canvas never sends a "selected" outcome, so `wait` will not
# report the user's selection; it only ever reports cancellation/timeout/
# disconnection for this canvas. Call `get` whenever you need to know what
# text (if any) is currently selected.
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts get doc-1 selection
```

`get <id> selection` prints `{"status":"ok","key":"selection","data":{"selectedText":...,"startOffset":...,"endOffset":...}}`
when text is currently selected, or `{"status":"ok","key":"selection","data":null}` when
nothing is selected. Poll it whenever you need the current selection — there
is no push notification for it.

`wait doc-1` still returns `{"status":"cancelled"}` if the user quits (`q`/`Esc`),
or `{"status":"pending"}` if it timed out (still alive — call `wait` again); it
never returns `{"status":"selected",...}` for the document canvas.

## Reviewing a code change

This canvas does **not** highlight diffs. It used to advertise a `diffs`
config field, but the only renderer that applied it was deleted as dead
code -- `document` never actually highlighted anything.

Use the `diff` canvas instead: it parses real unified diff output, walks it
hunk by hunk, and returns a per-hunk approve/reject decision. See the `diff`
skill.
