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

test("PgDn scrolls within a long hunk and PgUp comes back", async () => {
  const r = renderCanvas(
    <Diff id="diff-8" config={{ diffText: LONG_HUNK_DIFF }} enabled={false} />,
    { columns: 80, rows: 20 }
  );
  expect(await r.settle()).toContain("lines 1-10 of 40");

  r.stdin.write("\x1b[6~"); // page down
  expect(await r.settle()).toContain("lines 2-11 of 40");

  r.stdin.write("\x1b[5~"); // page up
  expect(await r.settle()).toContain("lines 1-10 of 40");

  r.dispose();
});
