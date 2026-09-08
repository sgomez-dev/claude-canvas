import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "ink";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { startCanvasServer, type CanvasServer } from "./server";
import { deleteRecord, writeRecord } from "./registry";
import { logPath } from "./paths";
import { detectHost, baseCapabilities, type TerminalCapabilities } from "../host";
import type { CanvasMessage } from "./protocol";

export interface UseCanvasServerOptions {
  id: string;
  kind: string;
  scenario: string;
  // Replaces the old "is socketPath truthy" test used by the two hooks this
  // one merges. When false: no server, no registry write, no host lookup —
  // Task 13's offline rendering (and `show` without a socket) depends on
  // this path doing nothing at all.
  enabled: boolean;
  onUpdate?(config: unknown): void;
  onGet?(key: string): unknown;
  onClose?(): void;
}

export interface CanvasServerHandle {
  isConnected: boolean;
  sendSelected(data: unknown): void;
  sendCancelled(reason?: string): void;
  sendError(message: string): void;
}

// Never console.log from canvas code: it writes over the Ink render. All
// diagnostics — including the onError wiring below — go to the per-canvas
// log file instead.
async function logToFile(id: string, message: string): Promise<void> {
  try {
    const path = logPath(id);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never take the canvas down.
  }
}

export function useCanvasServer(o: UseCanvasServerOptions): CanvasServerHandle {
  const { id, kind, scenario, enabled } = o;
  const { exit } = useApp();
  const [isConnected, setIsConnected] = useState(false);
  const serverRef = useRef<CanvasServer | null>(null);
  const cbs = useRef(o);

  useEffect(() => {
    cbs.current = o;
  });

  useEffect(() => {
    if (!enabled) return;
    let live = true;

    (async () => {
      // The IPC transport (TCP) needs no host at all; only `spawn` genuinely
      // needs one, to open a pane. `show` in a plain terminal (no spawn) is a
      // documented supported flow (skills/canvas/SKILL.md, canvas/README.md),
      // so detectHost() throwing NoHostError outside tmux/Windows Terminal
      // must not stop the server from starting here — fall back to a
      // host-less shape and keep going. NoHostError should only ever surface
      // from `spawn`.
      let hostName = "none";
      let capabilities: TerminalCapabilities = baseCapabilities(process.env);
      try {
        const host = detectHost();
        hostName = host.name;
        capabilities = host.capabilities(process.env);
      } catch {
        // No host available; proceed host-less. See comment above.
      }
      try {
        const server = await startCanvasServer({
          onMessage(msg, reply) {
            switch (msg.type) {
              case "update":
                cbs.current.onUpdate?.(msg.config);
                break;
              case "get":
                reply({ type: "value", key: msg.key, data: cbs.current.onGet?.(msg.key) ?? null });
                break;
              case "ping":
                reply({ type: "pong" });
                break;
              case "close":
                cbs.current.onClose?.();
                exit();
                break;
            }
          },
          // Task 6 routes a throwing onMessage into onError instead of
          // crashing the process (a canvas must always exit 0). Leaving
          // onError unwired here would make any bug in the callbacks above
          // silently disappear, so every failure lands in the log file.
          onError(e) {
            void logToFile(id, `ipc error: ${e.message}`);
          },
        });
        if (!live) {
          server.stop();
          return;
        }
        serverRef.current = server;
        await writeRecord({
          id,
          kind,
          scenario,
          port: server.port,
          token: server.token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: hostName,
          wtSession: process.env.WT_SESSION,
        });
        setIsConnected(true);
        server.broadcast({ type: "ready", scenario, capabilities });
      } catch (e) {
        // A canvas must still exit 0, so a startup failure travels in the
        // registry record and the log file rather than throwing out of this
        // effect. Skipped if we already unmounted: the cleanup below has run
        // and would otherwise be undone by this write landing afterward.
        if (!live) return;
        void logToFile(id, `startup failed: ${(e as Error).message}`);
        await writeRecord({
          id,
          kind,
          scenario,
          port: 0,
          token: "",
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: "none",
          lastError: (e as Error).message,
        }).catch(() => {});
      }
    })();

    return () => {
      live = false;
      serverRef.current?.stop();
      serverRef.current = null;
      void deleteRecord(id);
    };
  }, [enabled, id, kind, scenario, exit]);

  const send = useCallback((msg: CanvasMessage) => {
    serverRef.current?.broadcast(msg);
  }, []);

  return {
    isConnected,
    sendSelected: useCallback((data: unknown) => send({ type: "selected", data }), [send]),
    sendCancelled: useCallback((reason?: string) => send({ type: "cancelled", reason }), [send]),
    sendError: useCallback((message: string) => send({ type: "error", message }), [send]),
  };
}
