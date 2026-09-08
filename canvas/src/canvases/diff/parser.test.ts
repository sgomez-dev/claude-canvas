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
