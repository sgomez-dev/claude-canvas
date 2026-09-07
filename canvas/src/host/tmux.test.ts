import { test, expect } from "bun:test";
import { tmuxHost } from "./tmux";

const spec = { argv: ["bun", "run", "cli.ts", "show", "document"], title: "canvas: document", ratio: 0.67 };

test("available only when TMUX is set", () => {
  expect(tmuxHost.isAvailable({ TMUX: "/tmp/s,1,0" })).toBe(true);
  expect(tmuxHost.isAvailable({})).toBe(false);
});

test("builds a split-window argv using -l, not the deprecated -p", () => {
  const argv = tmuxHost.buildArgv(spec);
  expect(argv[0]).toBe("tmux");
  expect(argv).toContain("split-window");
  expect(argv).toContain("-h");
  expect(argv).toContain("-l");
  expect(argv).toContain("67%");
  expect(argv).not.toContain("-p");
});

test("separates payload argv with -- so payload flags are not eaten", () => {
  const argv = tmuxHost.buildArgv(spec);
  const sep = argv.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(argv.slice(sep + 1)).toEqual(spec.argv);
});

test("never uses send-keys", () => {
  expect(tmuxHost.buildArgv(spec)).not.toContain("send-keys");
});

test("payload arguments stay separate elements, never joined into a string", () => {
  const argv = tmuxHost.buildArgv({ ...spec, argv: ["bun", "a b", "c;d"] });
  expect(argv).toContain("a b");
  expect(argv).toContain("c;d");
  expect(argv.some((a) => a.includes("bun a b"))).toBe(false);
});
