import { test, expect } from "bun:test";
import React from "react";
import { Diff } from "../../src/canvases/diff";
import { renderCanvas } from "../harness/render";

const SAMPLE_DIFF = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old a
+new a
 shared
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-old b
+new b
`;

test("diff canvas renders a multi-file diff", async () => {
  const r = renderCanvas(
    <Diff id="diff-1" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// Regression test for Fix 2: `diff/validate.ts` used to call
// `config.diffText.trim()` with no type check, so a non-string `diffText`
// (a number here) threw a raw TypeError inside the `useMemo` that calls it,
// during render -- before `useCanvasServer`'s effect ever ran, so no
// registry record was written and Ink showed its own raw error screen (a
// React stack trace) instead of the canvas's red error box. Render must
// succeed and show a validation error, not throw.
test("a non-string diffText produces a validation error instead of crashing the render", async () => {
  const r = renderCanvas(
    <Diff id="diff-9" config={{ diffText: 12345 as never }} enabled={false} />,
    { columns: 80, rows: 10 }
  );
  const frame = await r.settle();
  expect(frame).toContain("diffText");
  expect(frame).toContain("must be a string");
  r.dispose();
});

test("diff canvas renders an empty-diff state", async () => {
  const r = renderCanvas(
    <Diff id="diff-2" config={{ title: "Review", diffText: "" }} scenario="review" enabled={false} />,
    { columns: 80, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("diff canvas renders a parse error state", async () => {
  const r = renderCanvas(
    <Diff id="diff-3" config={{ title: "Review", diffText: "not a diff" }} scenario="review" enabled={false} />,
    { columns: 80, rows: 10 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// Every other snapshot in this file captures only the initial render (cursor
// at hunk 0, everything undecided). This one exercises one navigation
// keypress and one decision keypress so a committed snapshot shows a moved
// cursor and a non-undecided hunk state.
test("diff canvas renders after navigating and approving a hunk", async () => {
  const r = renderCanvas(
    <Diff id="diff-5" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  await r.settle();
  r.stdin.write("j"); // move from a.txt's hunk to b.txt's hunk
  await r.settle();
  r.stdin.write("a"); // approve it
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("diff canvas is deterministic across renders", async () => {
  const a = renderCanvas(
    <Diff id="diff-4" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  const first = await a.settle();
  a.dispose();
  const b = renderCanvas(
    <Diff id="diff-4" config={{ title: "Review", diffText: SAMPLE_DIFF }} scenario="review" enabled={false} />,
    { columns: 80, rows: 24 }
  );
  const second = await b.settle();
  b.dispose();
  expect(second).toBe(first);
});

// A diff whose only file is binary has nothing to review but plenty to
// show. The spec says a binary file is "shown as a label"; the
// no-hunks early return used to fire first and hide the file list entirely,
// so the pane read "Nothing to review." and never named the file.
const BINARY_ONLY_DIFF = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

test("diff canvas lists a binary-only diff instead of claiming nothing to review", async () => {
  const r = renderCanvas(
    <Diff id="diff-6" config={{ title: "Assets", diffText: BINARY_ONLY_DIFF }} enabled={false} />,
    { columns: 80, rows: 16 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// 40 lines in a 20-row pane. Without a viewport every line rendered, and the
// overflow pushed the decision marker and the footer hint out of view.
const LONG_HUNK_DIFF = `diff --git a/big.txt b/big.txt
--- a/big.txt
+++ b/big.txt
@@ -1,40 +1,40 @@
${Array.from({ length: 40 }, (_, i) => ` line ${i + 1}`).join("\n")}
`;

test("diff canvas windows a hunk longer than the pane", async () => {
  const r = renderCanvas(
    <Diff id="diff-7" config={{ diffText: LONG_HUNK_DIFF }} enabled={false} />,
    { columns: 80, rows: 20 }
  );
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// Regression test for Fix 3's footer-wrap half: at a narrow terminal width
// the footer hint text (77 columns) wraps onto a second line inside a
// terminal narrower than that, which the row-budget math's flat "one line
// of hint text" assumption didn't account for, pushing content off the top
// of the frame. Verified at the exact dimensions the independent review
// reproduced this at.
test("at a narrow terminal width, the frame never exceeds the terminal's row count", async () => {
  const rows = 15;
  const r = renderCanvas(
    <Diff id="diff-11" config={{ diffText: LONG_HUNK_DIFF }} enabled={false} />,
    { columns: 60, rows }
  );
  const frame = await r.settle();
  expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
  r.dispose();
});

test("PgDn scrolls within a long hunk and PgUp comes back", async () => {
  const r = renderCanvas(
    <Diff id="diff-8" config={{ diffText: LONG_HUNK_DIFF }} enabled={false} />,
    { columns: 80, rows: 20 }
  );
  // 9 hunk-body rows visible per CHROME_ROWS=10 (was 10 rows visible under
  // the pre-fix CHROME_ROWS=9, which was exactly the off-by-one Fix 3(a)
  // corrects).
  expect(await r.settle()).toContain("lines 1-9 of 40");

  r.stdin.write("\x1b[6~"); // page down
  expect(await r.settle()).toContain("lines 2-10 of 40");

  r.stdin.write("\x1b[5~"); // page up
  expect(await r.settle()).toContain("lines 1-9 of 40");

  r.dispose();
});

// Regression for Fix 3(b): PageDown past the end of the content used to
// keep growing the internal `lineOffset` past the valid maximum -- the
// render clamped what was DISPLAYED, but the stored value kept climbing, so
// the first several PageUp presses after an overshoot appeared to do
// nothing while the value came back down through the overshot range. This
// pins that a single PageUp immediately undoes a single PageDown even after
// many PageDowns have overshot the end.
test("PageUp works immediately after PageDown overshoots past the end of the content", async () => {
  const r = renderCanvas(
    <Diff id="diff-10" config={{ diffText: LONG_HUNK_DIFF }} enabled={false} />,
    { columns: 80, rows: 20 }
  );
  await r.settle();

  // 40 lines, 9 visible per page: the valid max offset is 40 - 9 = 31
  // (0-indexed), displayed as "lines 32-40 of 40". Send far more PageDowns
  // than needed to reach it, so the pre-fix internal value would overshoot
  // well past 31.
  for (let i = 0; i < 50; i++) {
    r.stdin.write("\x1b[6~");
    await r.settle();
  }
  expect(await r.settle()).toContain("lines 32-40 of 40"); // clamped to the max

  r.stdin.write("\x1b[5~"); // a single PageUp
  expect(await r.settle()).toContain("lines 31-39 of 40"); // must move immediately

  r.dispose();
});
