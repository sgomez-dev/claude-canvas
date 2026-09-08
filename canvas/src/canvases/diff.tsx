import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useCanvasServer } from "../runtime/use-canvas-server";
import { parseUnifiedDiff, DiffParseError } from "./diff/parser";
import type { DiffFile, DiffReviewConfig, DiffReviewResult, HunkDecision } from "./diff/types";

export interface DiffProps {
  id: string;
  config?: DiffReviewConfig;
  scenario?: string;
  enabled: boolean;
}

interface FlatHunkRef {
  fileIndex: number;
  hunkIndex: number;
}

export function Diff({ id, config, scenario = "review", enabled }: DiffProps): React.JSX.Element {
  const { exit } = useApp();
  const [parseError, setParseError] = useState<string | null>(null);
  const files: DiffFile[] = useMemo(() => {
    if (!config?.diffText || config.diffText.trim().length === 0) return [];
    try {
      return parseUnifiedDiff(config.diffText);
    } catch (e) {
      setParseError(e instanceof DiffParseError ? e.message : "Failed to parse diff.");
      return [];
    }
  }, [config?.diffText]);

  const flatHunks: FlatHunkRef[] = useMemo(() => {
    const refs: FlatHunkRef[] = [];
    files.forEach((f, fileIndex) => {
      f.hunks.forEach((_h, hunkIndex) => refs.push({ fileIndex, hunkIndex }));
    });
    return refs;
  }, [files]);

  const [cursor, setCursor] = useState(0);
  const [decisions, setDecisions] = useState<Map<string, HunkDecision>>(new Map());

  const ipc = useCanvasServer({
    id,
    kind: "diff",
    scenario,
    enabled,
    onClose: () => {},
  });

  useInput((input, key) => {
    if (files.length === 0) return;
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(flatHunks.length - 1, c + 1));
    } else if (input === "a") {
      const ref = flatHunks[cursor];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "approved"));
      }
    } else if (input === "r") {
      const ref = flatHunks[cursor];
      if (ref) {
        const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
        setDecisions((prev) => new Map(prev).set(hunk.id, "rejected"));
      }
    } else if (key.return) {
      const result: DiffReviewResult = {
        decisions: flatHunks.map((ref) => {
          const hunk = files[ref.fileIndex]!.hunks[ref.hunkIndex]!;
          return { hunkId: hunk.id, decision: decisions.get(hunk.id) ?? "rejected" };
        }),
      };
      ipc.sendSelected(result);
      exit();
    } else if (key.escape) {
      ipc.sendCancelled("escape");
      exit();
    }
  });

  if (parseError) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">Failed to parse diff: {parseError}</Text>
      </Box>
    );
  }

  if (files.length === 0) {
    return (
      <Box borderStyle="round" padding={1}>
        <Text dimColor>Nothing to review.</Text>
      </Box>
    );
  }

  const currentRef = flatHunks[cursor];
  const currentFile = currentRef ? files[currentRef.fileIndex] : undefined;
  const currentHunk = currentRef ? currentFile?.hunks[currentRef.hunkIndex] : undefined;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{config?.title ?? "Review Changes"}</Text>
        {files.map((f) => {
          const total = f.hunks.length;
          const decided = f.hunks.filter((h) => decisions.has(h.id)).length;
          const marker = f.binary ? "[binary]" : `${decided}/${total} decided`;
          const isCurrentFile = currentRef?.fileIndex === files.indexOf(f);
          return (
            <Text key={f.newPath} color={isCurrentFile ? "cyan" : undefined}>
              {isCurrentFile ? "> " : "  "}
              {f.newPath} ({f.status}) {marker}
            </Text>
          );
        })}
      </Box>
      {currentHunk && currentFile ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          <Text dimColor>{currentHunk.header}</Text>
          {currentHunk.lines.map((line, i) => (
            <Text
              key={i}
              color={line.type === "add" ? "green" : line.type === "remove" ? "red" : undefined}
            >
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              {line.content}
            </Text>
          ))}
          <Text bold color={decisions.get(currentHunk.id) === "approved" ? "green" : decisions.get(currentHunk.id) === "rejected" ? "red" : "yellow"}>
            [{decisions.get(currentHunk.id) ?? "undecided"}]
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>a: approve  r: reject  ↑/↓: navigate  Enter: submit  Esc: cancel</Text>
      </Box>
    </Box>
  );
}
