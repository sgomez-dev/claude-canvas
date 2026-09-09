import { test, expect } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import type { Socket } from "bun";
import { unlink } from "node:fs/promises";
import { useCanvasServer, type CanvasServerHandle } from "./use-canvas-server";
import { renderCanvas } from "../../test/harness/render";
import { waitUntil } from "../../test/harness/ipc";
import { readRecord, deleteRecord } from "./registry";
import { logPath } from "./paths";
import { encodeFrame, FrameDecoder, type CanvasMessage, type ControllerMessage } from "./protocol";

test("disabled hook renders without opening a server", async () => {
  function Probe() {
    const ipc = useCanvasServer({ id: "hook-off", kind: "document", scenario: "display", enabled: false });
    return (
      <Box>
        <Text>connected={String(ipc.isConnected)}</Text>
      </Box>
    );
  }
  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  try {
    expect(await r.settle()).toContain("connected=false");
    // The offline path must not touch the registry either: no record was
    // ever written for this id, so nothing needs cleaning up.
    expect(await readRecord("hook-off")).toBeNull();
  } finally {
    r.dispose();
  }
});

test("disabled hook sends are safe no-ops", async () => {
  function Sender() {
    const ipc = useCanvasServer({ id: "hook-off2", kind: "document", scenario: "display", enabled: false });
    ipc.sendSelected({ a: 1 });
    ipc.sendCancelled("x");
    ipc.sendError("y");
    return <Text>ok</Text>;
  }
  const r = renderCanvas(<Sender />, { columns: 20, rows: 3 });
  try {
    expect(await r.settle()).toContain("ok");
  } finally {
    r.dispose();
  }
});

// A minimal, persistent TCP client for the tests below: unlike protocol- and
// server-level tests elsewhere in this file's neighbourhood, these tests
// drive the hook end-to-end, so the client needs to stay open across several
// exchanges rather than a single request/response.
async function connectClient(port: number): Promise<{
  messages: CanvasMessage[];
  send(msg: ControllerMessage): void;
  close(): void;
}> {
  const messages: CanvasMessage[] = [];
  const dec = new FrameDecoder();
  const socket: Socket<undefined> = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        for (const m of dec.push(new Uint8Array(d))) messages.push(m as CanvasMessage);
      },
    },
  });
  return {
    messages,
    send(msg) {
      socket.write(encodeFrame(msg));
    },
    close() {
      try {
        socket.end();
      } catch {
        // already closed
      }
    },
  };
}

function withEnv<K extends "TMUX" | "WT_SESSION">(key: K, value: string): () => void {
  const saved = process.env[key];
  process.env[key] = value;
  return () => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
}

async function waitForRecord(id: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await readRecord(id);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`registry record for "${id}" never appeared`);
}

const OUTCOME_TYPES = new Set(["selected", "cancelled", "error"]);
function outcomesIn(messages: unknown[]): unknown[] {
  return messages.filter((m) => OUTCOME_TYPES.has((m as { type: string }).type));
}

test("enabled hook starts a real server, registers it, and round-trips every message kind", async () => {
  const restoreEnv = withEnv("TMUX", "/tmp/fake,1,0");
  const id = "hook-on";
  let updateSeen: unknown;
  let getSeen: string | undefined;
  let handle: CanvasServerHandle | undefined;

  function Probe() {
    handle = useCanvasServer({
      id,
      kind: "document",
      scenario: "display",
      enabled: true,
      onUpdate(config) {
        updateSeen = config;
      },
      onGet(key) {
        getSeen = key;
        return { echoed: key };
      },
    });
    return (
      <Box>
        <Text>connected={String(handle.isConnected)}</Text>
      </Box>
    );
  }

  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    const record = await waitForRecord(id);
    // Discriminates a real, working registration -- not just "a record
    // exists" -- since a hook that wired the wrong host or a stale token
    // would still produce *a* record.
    expect(record.host).toBe("tmux");
    expect(record.port).toBeGreaterThan(0);
    expect(record.lastError).toBeUndefined();
    expect(await r.settle()).toContain("connected=true");

    client = await connectClient(record.port);
    client.send({ type: "hello", token: record.token });
    await waitUntil(() => client!.messages.some((m) => (m as { type: string }).type === "hello-ok"));
    expect(client.messages).toContainEqual({ type: "hello-ok" });
    // `ready` used to be unassertable: the hook broadcast it the instant
    // the record was written, before any controller could have read the
    // port, so it reached nobody. It is now retained and replayed to a
    // controller as it authenticates, which is what makes it observable at
    // all. Capabilities are deliberately not asserted -- trueColor comes
    // from COLORTERM and the dimensions from the terminal, so pinning them
    // would pin the machine.
    await waitUntil(() => client!.messages.some((m) => (m as { type: string }).type === "ready"));
    const ready = client.messages.find((m) => (m as { type: string }).type === "ready");
    expect(ready).toBeDefined();
    expect((ready as unknown as { scenario: string }).scenario).toBe("display");

    client.send({ type: "get", key: "content" });
    // Fix 7. This used to poll `getSeen === "content"` -- which only proves
    // the SERVER received the request -- and then assert on the CLIENT
    // having the reply, which arrives strictly later (it has to cross the
    // socket back). Under load the reply had not arrived yet when the
    // assertion ran. Poll for the condition actually being asserted instead.
    await waitUntil(() =>
      client!.messages.some(
        (m) => (m as { type: string }).type === "value" && (m as { key: string }).key === "content"
      )
    );
    expect(getSeen).toBe("content");
    expect(client.messages).toContainEqual({ type: "value", key: "content", data: { echoed: "content" } });

    client.send({ type: "update", config: { x: 1 } });
    await waitUntil(() => updateSeen !== undefined);
    expect(updateSeen).toEqual({ x: 1 });

    // First outcome wins, and the two after it are dropped. A canvas has
    // exactly one answer; letting a later call overwrite it would mean a
    // controller's `wait` returned whichever of two contradictory outcomes
    // it happened to read, and the persisted copy could disagree with the
    // broadcast one.
    handle!.sendSelected({ picked: 2 });
    handle!.sendCancelled("nvm");
    handle!.sendError("oops");
    await waitUntil(() => outcomesIn(client!.messages).length >= 1);
    expect(client.messages).toContainEqual({ type: "selected", data: { picked: 2 } });
    expect(outcomesIn(client.messages)).toHaveLength(1);
  } finally {
    client?.close();
    r.dispose();
    // No assertion depends on the passive unmount cleanup having finished
    // here -- the explicit deleteRecord below is an idempotent backstop
    // regardless of whether it has -- so nothing to poll for; just clean up.
    await deleteRecord(id);
    restoreEnv();
  }
});

test("unmounting stops the server and removes the registry record", async () => {
  const restoreEnv = withEnv("TMUX", "/tmp/fake,1,0");
  const id = "hook-unmount";
  let handle: CanvasServerHandle | undefined;

  function Probe() {
    handle = useCanvasServer({ id, kind: "document", scenario: "display", enabled: true });
    return <Text>connected={String(handle.isConnected)}</Text>;
  }

  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  try {
    const record = await waitForRecord(id);
    expect(await r.settle()).toContain("connected=true");

    r.dispose();
    // Unmount's cleanup (server.stop() + deleteRecord()) is a passive
    // effect, so it runs some macrotasks after synchronous unmount returns
    // -- poll for it rather than guessing how many.
    await waitUntil(async () => (await readRecord(id)) === null);

    // The record is gone (not merely stale/dead-pid gone -- readRecord would
    // also return null for a dead pid -- so also prove the port itself is
    // no longer accepting connections).
    expect(await readRecord(id)).toBeNull();
    await expect(
      Bun.connect({ hostname: "127.0.0.1", port: record.port, socket: { data() {} } })
    ).rejects.toBeTruthy();
  } finally {
    await deleteRecord(id);
    restoreEnv();
  }
});

test("a throwing onUpdate callback is routed to the log file, not dropped or crashed", async () => {
  const restoreEnv = withEnv("TMUX", "/tmp/fake,1,0");
  const id = "hook-err";
  const path = logPath(id);
  await unlink(path).catch(() => {});

  function Probe() {
    const ipc = useCanvasServer({
      id,
      kind: "document",
      scenario: "display",
      enabled: true,
      onUpdate() {
        throw new Error("boom-from-onUpdate");
      },
    });
    return <Text>connected={String(ipc.isConnected)}</Text>;
  }

  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    const record = await waitForRecord(id);
    expect(await r.settle()).toContain("connected=true");

    client = await connectClient(record.port);
    client.send({ type: "hello", token: record.token });
    await waitUntil(() => client!.messages.some((m) => (m as { type: string }).type === "hello-ok"));
    client.send({ type: "update", config: { anything: true } });
    // Give the throw time to travel: server.ts's try/catch around
    // onMessage -> our onError -> logToFile's async appendFile. Poll the log
    // file directly rather than guessing how long that chain takes.
    await waitUntil(async () => (await Bun.file(path).text().catch(() => "")).includes("boom-from-onUpdate"));

    const log = await Bun.file(path).text();
    expect(log).toContain("ipc error:");
    expect(log).toContain("boom-from-onUpdate");

    // The connection itself must still be alive: Task 6's contract is that
    // a throwing onMessage is caught per-message, not fatal to the socket.
    client.send({ type: "ping" });
    await waitUntil(() => client!.messages.some((m) => (m as { type: string }).type === "pong"));
    expect(client.messages).toContainEqual({ type: "pong" });
  } finally {
    client?.close();
    r.dispose();
    await deleteRecord(id);
    await unlink(path).catch(() => {});
    restoreEnv();
  }
});

// Review finding: this hook used to call detectHost() unconditionally before
// starting the server, so NoHostError (thrown outside tmux/Windows Terminal)
// stopped the server from starting at all -- even though `show` in a plain
// terminal (no spawn, no pane, no host needed -- the IPC transport is plain
// TCP) is a documented supported flow. Only `spawn` genuinely needs a host,
// to open a pane; NoHostError must surface there, never from this hook.
test("a missing host at startup still starts the server, host-less, instead of failing to start", async () => {
  const savedTmux = process.env.TMUX;
  const savedWt = process.env.WT_SESSION;
  delete process.env.TMUX;
  delete process.env.WT_SESSION;
  const id = "hook-nohost";
  const path = logPath(id);
  await unlink(path).catch(() => {});

  function Probe() {
    const ipc = useCanvasServer({ id, kind: "document", scenario: "display", enabled: true });
    return <Text>connected={String(ipc.isConnected)}</Text>;
  }

  const r = renderCanvas(<Probe />, { columns: 40, rows: 3 });
  try {
    const record = await waitForRecord(id);
    // No host detected -> falls back to a "none"-shaped host, not a startup
    // failure: no lastError, and the server comes up and accepts connections
    // exactly as it would with a real host.
    expect(record.lastError).toBeUndefined();
    expect(record.host).toBe("none");
    expect(record.port).toBeGreaterThan(0);
    expect(await r.settle()).toContain("connected=true");

    // Sanity: the port genuinely accepts a connection -- proves this isn't
    // just a registry write with no server behind it.
    const client = await connectClient(record.port);
    try {
      client.send({ type: "hello", token: record.token });
      await waitUntil(() => client.messages.some((m) => (m as { type: string }).type === "hello-ok"));
      expect(client.messages).toContainEqual({ type: "hello-ok" });
    } finally {
      client.close();
    }

    const log = await Bun.file(path).text().catch(() => "");
    expect(log).not.toContain("startup failed:");
  } finally {
    r.dispose();
    await deleteRecord(id);
    await unlink(path).catch(() => {});
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedWt === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = savedWt;
  }
});
