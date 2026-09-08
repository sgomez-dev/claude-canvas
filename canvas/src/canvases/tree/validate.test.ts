import { test, expect } from "bun:test";
import { validateTree } from "./validate";

const OK = {
  nodes: [
    { id: "src", label: "src", children: [{ id: "src/a.ts", label: "a.ts" }] },
    { id: "readme", label: "README.md", badge: "M" },
  ],
};

test("accepts a well-formed tree", () => {
  const { nodes, error } = validateTree(OK as never);
  expect(error).toBeNull();
  expect(nodes).toHaveLength(2);
});

test("rejects nodes that are not an array, or empty", () => {
  expect(validateTree({ nodes: "no" } as never).error).toMatch(/must be an array/);
  expect(validateTree({ nodes: [] } as never).error).toMatch(/must not be empty/);
  expect(validateTree(undefined).error).toMatch(/must be an array/);
});

test("rejects a node missing id or label, naming where it is", () => {
  expect(validateTree({ nodes: [{ label: "x" }] } as never).error).toMatch(
    /the root.*missing 'id'/
  );
  expect(validateTree({ nodes: [{ id: "x" }] } as never).error).toMatch(/"x" is missing 'label'/);
});

// Ids must be unique across the WHOLE tree, not just among siblings: a
// selection reports one id and the collapse state is keyed by id, so a
// duplicate makes both ambiguous.
test("rejects a duplicate id anywhere in the tree, not just among siblings", () => {
  const dup = {
    nodes: [
      { id: "a", label: "A", children: [{ id: "shared", label: "deep" }] },
      { id: "shared", label: "shallow" },
    ],
  };
  expect(validateTree(dup as never).error).toMatch(/duplicate node id "shared"/);
});

test("rejects malformed children", () => {
  expect(
    validateTree({ nodes: [{ id: "a", label: "A", children: "no" }] } as never).error
  ).toMatch(/'children' of "A" must be an array/);
});

// A tree deep enough to matter is a tree someone built by accident. The cap
// is what stops a malformed config recursing until the stack gives out --
// and a canvas must always be able to exit 0, which a stack overflow takes
// away.
test("rejects nesting past the depth cap instead of overflowing the stack", () => {
  let node: Record<string, unknown> = { id: "leaf", label: "leaf" };
  for (let i = 0; i < 40; i++) {
    node = { id: `n${i}`, label: `n${i}`, children: [node] };
  }
  expect(validateTree({ nodes: [node] } as never).error).toMatch(/nesting deeper than 32/);
});

test("a tree at exactly the depth cap is accepted", () => {
  let node: Record<string, unknown> = { id: "leaf", label: "leaf" };
  for (let i = 0; i < 30; i++) {
    node = { id: `n${i}`, label: `n${i}`, children: [node] };
  }
  expect(validateTree({ nodes: [node] } as never).error).toBeNull();
});
