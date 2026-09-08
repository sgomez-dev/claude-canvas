import { test, expect, describe } from "bun:test";
import { parseUnifiedDiff, DiffParseError } from "./parser";

const SIMPLE_MODIFIED = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@
 line one
-line two
+line two changed
+line three new
 line four
`;

const MULTI_FILE = `diff --git a/a.txt b/a.txt
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

const ADDED_FILE = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED_FILE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1234567..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;

const RENAMED_FILE = `diff --git a/old-name.txt b/new-name.txt
similarity index 100%
rename from old-name.txt
rename to new-name.txt
`;

// A file renamed AND modified: git's rename detection is on by default and
// commonly produces exactly this shape -- `rename from`/`rename to` lines
// followed by a normal `---`/`+++`/`@@` hunk.
const RENAMED_AND_MODIFIED_FILE = `diff --git a/old-name.txt b/new-name.txt
similarity index 80%
rename from old-name.txt
rename to new-name.txt
--- a/old-name.txt
+++ b/new-name.txt
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO changed
 line three
`;

// Real `diff -u a/x.txt b/x.txt > out.diff; diff -u a/y.txt b/y.txt >>
// out.diff`-style output for two files back to back, no `diff --git`
// header -- captured from an actual GNU diffutils 3.12 run (timestamps
// stripped from the `---`/`+++` lines, which this parser doesn't consume
// anyway; every other byte, including the single-space context-line
// prefix, is exactly what `diff -u` produced).
const PLAIN_TWO_FILE_DIFF = `--- a/x.txt
+++ b/x.txt
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO changed
 line three
--- a/y.txt
+++ b/y.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+BETA changed
`;

// Same real `diff -u` capture as PLAIN_TWO_FILE_DIFF, extended with a 3rd
// file. Regression coverage for the `seenHeaderInCurrent` reset bug: reset
// to `false` unconditionally on every new block would let a 3rd file's
// header pair -- the very line that opens its own new block -- be treated
// as "not yet seen" for that new block, so a hypothetical 4th file's pair
// wouldn't split off it; more importantly, resetting to `false` regardless
// of what started the block was also observed (before this fix) to
// misattribute the 3rd file into the 2nd file's block under the 2nd file's
// path in this exact shape. seenHeaderInCurrent must be initialized from
// `isHeaderPair` for the line that started the new block, not hardcoded to
// `false`.
const PLAIN_THREE_FILE_DIFF = `--- a/x.txt
+++ b/x.txt
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO changed
 line three
--- a/y.txt
+++ b/y.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+BETA changed
--- a/z.txt
+++ b/z.txt
@@ -1,2 +1,2 @@
-one
+ONE
 two
`;

const BINARY_FILE = `diff --git a/image.png b/image.png
index 1234567..89abcde 100644
Binary files a/image.png and b/image.png differ
`;

const NO_TRAILING_NEWLINE = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  test("parses a single modified file with one hunk", () => {
    const files = parseUnifiedDiff(SIMPLE_MODIFIED);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.oldPath).toBe("foo.txt");
    expect(file.newPath).toBe("foo.txt");
    expect(file.status).toBe("modified");
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.id).toBe("foo.txt#0");
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines).toEqual([
      { type: "context", content: "line one", oldLineNo: 1, newLineNo: 1 },
      { type: "remove", content: "line two", oldLineNo: 2 },
      { type: "add", content: "line two changed", newLineNo: 2 },
      { type: "add", content: "line three new", newLineNo: 3 },
      { type: "context", content: "line four", oldLineNo: 3, newLineNo: 4 },
    ]);
  });

  test("parses multiple files in one diff", () => {
    const files = parseUnifiedDiff(MULTI_FILE);
    expect(files).toHaveLength(2);
    expect(files[0]!.newPath).toBe("a.txt");
    expect(files[1]!.newPath).toBe("b.txt");
    expect(files[0]!.hunks[0]!.id).toBe("a.txt#0");
    expect(files[1]!.hunks[0]!.id).toBe("b.txt#0");
  });

  test("detects an added file", () => {
    const files = parseUnifiedDiff(ADDED_FILE);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.hunks[0]!.lines.every((l) => l.type === "add")).toBe(true);
  });

  test("detects a deleted file", () => {
    const files = parseUnifiedDiff(DELETED_FILE);
    expect(files[0]!.status).toBe("deleted");
    expect(files[0]!.hunks[0]!.lines.every((l) => l.type === "remove")).toBe(true);
  });

  test("detects a renamed file with no hunks", () => {
    const files = parseUnifiedDiff(RENAMED_FILE);
    expect(files[0]!.status).toBe("renamed");
    expect(files[0]!.oldPath).toBe("old-name.txt");
    expect(files[0]!.newPath).toBe("new-name.txt");
    expect(files[0]!.hunks).toHaveLength(0);
  });

  // Regression: the renameFrom/renameTo branch used to return before any
  // hunk parsing, silently discarding a renamed-and-modified file's hunks.
  test("a file that is both renamed and modified keeps its hunks", () => {
    const files = parseUnifiedDiff(RENAMED_AND_MODIFIED_FILE);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old-name.txt");
    expect(file.newPath).toBe("new-name.txt");
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.id).toBe("new-name.txt#0");
    expect(hunk.lines).toEqual([
      { type: "context", content: "line one", oldLineNo: 1, newLineNo: 1 },
      { type: "remove", content: "line two", oldLineNo: 2 },
      { type: "add", content: "line TWO changed", newLineNo: 2 },
      { type: "context", content: "line three", oldLineNo: 3, newLineNo: 3 },
    ]);
  });

  // Regression: splitIntoFileBlocks's block-start condition only recognized
  // a bare `--- a/...` line as a new block for the VERY FIRST file (guarded
  // by `current.length === 0`) -- a second plain-format (`diff -u`, no
  // `diff --git` header) file's `--- a/y` line was swallowed into the first
  // file's block as ordinary content. Fixture captured from a real
  // `diff -u` run (see PLAIN_TWO_FILE_DIFF above).
  test("splits a plain diff -u (no `diff --git` header) multi-file diff into separate files", () => {
    const files = parseUnifiedDiff(PLAIN_TWO_FILE_DIFF);
    expect(files).toHaveLength(2);

    const x = files[0]!;
    expect(x.oldPath).toBe("x.txt");
    expect(x.newPath).toBe("x.txt");
    expect(x.status).toBe("modified");
    expect(x.hunks).toHaveLength(1);
    expect(x.hunks[0]!.id).toBe("x.txt#0");
    expect(x.hunks[0]!.lines).toEqual([
      { type: "context", content: "line one", oldLineNo: 1, newLineNo: 1 },
      { type: "remove", content: "line two", oldLineNo: 2 },
      { type: "add", content: "line TWO changed", newLineNo: 2 },
      { type: "context", content: "line three", oldLineNo: 3, newLineNo: 3 },
    ]);

    const y = files[1]!;
    expect(y.oldPath).toBe("y.txt");
    expect(y.newPath).toBe("y.txt");
    expect(y.status).toBe("modified");
    expect(y.hunks).toHaveLength(1);
    expect(y.hunks[0]!.id).toBe("y.txt#0");
    expect(y.hunks[0]!.lines).toEqual([
      { type: "context", content: "alpha", oldLineNo: 1, newLineNo: 1 },
      { type: "remove", content: "beta", oldLineNo: 2 },
      { type: "add", content: "BETA changed", newLineNo: 2 },
    ]);
  });

  // Regression: a follow-up review found the first fix's `seenHeaderInCurrent
  // = false` reset (on every new block) let a 3RD plain-diff file get
  // swallowed into the 2nd file's block under the 2nd file's path/hunk id --
  // same harm class as the original finding, just one file later. Fixed by
  // resetting to `isHeaderPair` (true when the new block was itself opened
  // by a header-pair line) instead of unconditionally `false`.
  test("splits a plain diff -u multi-file diff with a THIRD file into separate files", () => {
    const files = parseUnifiedDiff(PLAIN_THREE_FILE_DIFF);
    expect(files).toHaveLength(3);

    expect(files[0]!.oldPath).toBe("x.txt");
    expect(files[0]!.hunks).toHaveLength(1);
    expect(files[0]!.hunks[0]!.id).toBe("x.txt#0");

    expect(files[1]!.oldPath).toBe("y.txt");
    expect(files[1]!.hunks).toHaveLength(1);
    expect(files[1]!.hunks[0]!.id).toBe("y.txt#0");

    const z = files[2]!;
    expect(z.oldPath).toBe("z.txt");
    expect(z.newPath).toBe("z.txt");
    expect(z.status).toBe("modified");
    expect(z.hunks).toHaveLength(1);
    expect(z.hunks[0]!.id).toBe("z.txt#0");
    expect(z.hunks[0]!.lines).toEqual([
      { type: "remove", content: "one", oldLineNo: 1 },
      { type: "add", content: "ONE", newLineNo: 1 },
      { type: "context", content: "two", oldLineNo: 2, newLineNo: 2 },
    ]);
  });

  test("marks a binary file as binary with no hunks, without throwing", () => {
    const files = parseUnifiedDiff(BINARY_FILE);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
  });

  test("handles a missing trailing newline marker without corrupting content", () => {
    const files = parseUnifiedDiff(NO_TRAILING_NEWLINE);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { type: "remove", content: "old", oldLineNo: 1 },
      { type: "add", content: "new", newLineNo: 1 },
    ]);
  });

  test("a hunk header with an implicit length of 1 parses correctly", () => {
    const text = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1 @@
-a
+b
`;
    const hunk = parseUnifiedDiff(text)[0]!.hunks[0]!;
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newLines).toBe(1);
  });

  test("throws DiffParseError on unparseable input", () => {
    expect(() => parseUnifiedDiff("this is not a diff at all\njust some text\n")).toThrow(
      DiffParseError
    );
  });

  test("empty input parses to an empty file list, not an error", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
