import { test, expect } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import type { Socket } from "bun";
import { unlink } from "node:fs/promises";
import { useCanvasServer, type CanvasServerHandle } from "./use-canvas-server";
import { renderCanvas } from "../../test/harness/render";
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
    await new Promise((res) => setTimeout(res, 60));
    expect(client.messages).toContainEqual({ type: "hello-ok" });
    // The hook's own "ready" broadcast fires immediately once the record is
    // written, before this test's client has connected -- the same race
    // openConnection's callers accept in production (a controller only
    // dials in once the registry record exists, by which point "ready" may
    // already have been sent to nobody). Not asserted here for that reason;
    // the get/update/send round-trips below are what this test pins.

    client.send({ type: "get", key: "content" });
    await new Promise((res) => setTimeout(res, 60));
    expect(getSeen).toBe("content");
    expect(client.messages).toContainEqual({ type: "value", key: "content", data: { echoed: "content" } });

    client.send({ type: "update", config: { x: 1 } });
    await new Promise((res) => setTimeout(res, 60));
    expect(updateSeen).toEqual({ x: 1 });

    handle!.sendSelected({ picked: 2 });
    handle!.sendCancelled("nvm");
    handle!.sendError("oops");
    await new Promise((res) => setTimeout(res, 60));
    expect(client.messages).toContainEqual({ type: "selected", data: { picked: 2 } });
    expect(client.messages).toContainEqual({ type: "cancelled", reason: "nvm" });
    expect(client.messages).toContainEqual({ type: "error", message: "oops" });
  } finally {
    client?.close();
    r.dispose();
    // Unmount's effect cleanup (server.stop() + deleteRecord()) runs as a
    // passive effect, one macrotask after synchronous unmount returns.
    await new Promise((res) => setTimeout(res, 40));
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
    await new Promise((res) => setTimeout(res, 60));

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
    await new Promise((res) => setTimeout(res, 60));
    client.send({ type: "update", config: { anything: true } });
    // Give the throw time to travel: server.ts's try/catch around
    // onMessage -> our onError -> logToFile's async appendFile.
    await new Promise((res) => setTimeout(res, 150));

    const log = await Bun.file(path).text();
    expect(log).toContain("ipc error:");
    expect(log).toContain("boom-from-onUpdate");

    // The connection itself must still be alive: Task 6's contract is that
    // a throwing onMessage is caught per-message, not fatal to the socket.
    client.send({ type: "ping" });
    await new Promise((res) => setTimeout(res, 60));
    expect(client.messages).toContainEqual({ type: "pong" });
  } finally {
    client?.close();
    r.dispose();
    await new Promise((res) => setTimeout(res, 40));
    await deleteRecord(id);
    await unlink(path).catch(() => {});
    restoreEnv();
  }
});

test("a missing host at startup writes a lastError record instead of throwing out of the app", async () => {
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
    let record = await readRecord(id);
    for (let i = 0; i < 30 && !record; i++) {
      await new Promise((res) => setTimeout(res, 20));
      record = await readRecord(id);
    }
    expect(record).not.toBeNull();
    expect(record!.lastError).toContain("No canvas host available");
    // isConnected must stay false: no server ever came up.
    expect(await r.settle()).toContain("connected=false");

    const log = await Bun.file(path).text();
    expect(log).toContain("startup failed:");
  } finally {
    r.dispose();
    await new Promise((res) => setTimeout(res, 40));
    await deleteRecord(id);
    await unlink(path).catch(() => {});
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedWt === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = savedWt;
  }
});
