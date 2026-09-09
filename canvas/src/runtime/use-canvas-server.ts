import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "ink";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { startCanvasServer, type CanvasServer } from "./server";
import {
  deleteRecord,
  deleteRecordSync,
  readRecordSync,
  writeRecord,
  writeRecordSync,
  type CanvasRecord,
} from "./registry";
import { logPath } from "./paths";
import { detectHost, baseCapabilities, type TerminalCapabilities } from "../host";
import type { CanvasMessage, OutcomeMessage } from "./protocol";

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

  // The record as written at startup, so the outcome can be merged into it
  // later without re-deriving every field.
  const recordRef = useRef<CanvasRecord | null>(null);
  // The `ready` message, retained so a controller that attaches later can
  // still be told what it attached to. It used to be broadcast the instant
  // the server came up -- before any controller could possibly have read
  // the port from the registry record -- which made it unobservable.
  const readyRef = useRef<CanvasMessage | null>(null);
  // The terminal outcome, retained for replay and persisted to disk. First
  // one wins: the components guard against a second outcome too, and this
  // is the backstop.
  const outcomeRef = useRef<OutcomeMessage | null>(null);

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
          // Replays what a controller would otherwise have missed by
          // attaching after the fact. This is the whole fix for the class
          // of bug where a user chose before `wait` connected: the outcome
          // was broadcast to zero connections and lost.
          onAuthenticated(reply) {
            if (readyRef.current) reply(readyRef.current);
            if (outcomeRef.current) reply(outcomeRef.current);
          },
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
        const record: CanvasRecord = {
          id,
          kind,
          scenario,
          port: server.port,
          token: server.token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: hostName,
          wtSession: process.env.WT_SESSION,
        };
        recordRef.current = record;
        await writeRecord(record);
        setIsConnected(true);
        readyRef.current = { type: "ready", scenario, capabilities };
        // Still broadcast, for the case where a controller somehow already
        // attached. onAuthenticated is what actually delivers it.
        server.broadcast(readyRef.current);
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
      // A record carrying an unread outcome must survive this unmount --
      // deleting it here is exactly how a user's choice used to become
      // unrecoverable. Whoever reads the outcome deletes it; listRecords
      // prunes one that is never read.
      if (!outcomeRef.current) {
        void deleteRecord(id);
        return;
      }
      // An outcome was produced. If a controller already consumed it live
      // over the socket while this canvas was still running (Fix 4 -- see
      // consumeOutcome in client.ts), the record was rewritten with
      // `outcomeConsumed: true` and its job is done: clean it up now rather
      // than leaving it to the hour-long TTL sweep in listRecords. If
      // nobody has read it yet, it must survive this unmount unchanged --
      // that durability is the whole point of persisting it in the first
      // place.
      //
      // This MUST be synchronous, not a fire-and-forget async IIFE (the
      // previous shape here). Ink's effect cleanups run synchronously during
      // unmount, but an async function's body only runs up to its first
      // `await` before control returns -- and the CLI's `show`/`spawn` flow
      // calls `process.exit(0)` immediately after `waitUntilExit()`
      // resolves, with nothing awaiting this cleanup in between. Reproduced
      // empirically: 5/5 runs, the record was never actually deleted with
      // the async version. readRecordSync/deleteRecordSync (real synchronous
      // syscalls, see their doc comments in registry.ts) close that gap.
      const current = readRecordSync(id);
      if (!current || current.outcomeConsumed) deleteRecordSync(id);
    };
  }, [enabled, id, kind, scenario, exit]);

  const send = useCallback((msg: CanvasMessage) => {
    serverRef.current?.broadcast(msg);
  }, []);

  // Records the outcome, persists it, and only then broadcasts it.
  //
  // The order matters and the synchronous write matters. Every caller of
  // this exits the app immediately afterwards, and process.exit does not
  // wait for a pending async write -- so an awaited write would lose the
  // race it exists to win. Persisting BEFORE the broadcast also means a
  // controller that reads the record instead of the socket can never see a
  // stale one.
  const emitOutcome = useCallback(
    (msg: OutcomeMessage) => {
      if (outcomeRef.current) return;
      outcomeRef.current = msg;
      // Recorded separately from startedAt: listRecords' TTL pruning
      // measures an outcome's age from THIS field, not from when the canvas
      // started. Conflating the two used to mean a canvas open longer than
      // the TTL (an hour) had its brand-new outcome pruned by the very next
      // `listRecords()` call, before any `wait` could read it.
      const outcomeAt = new Date().toISOString();
      try {
        const base = recordRef.current;
        writeRecordSync(
          base
            ? { ...base, outcome: msg, outcomeAt }
            : {
                // No record yet means the server never finished starting.
                // The outcome is still worth persisting -- a config error
                // reported before startup completed is precisely the case
                // a controller could not otherwise observe at all.
                id,
                kind,
                scenario,
                port: 0,
                token: "",
                pid: process.pid,
                startedAt: outcomeAt,
                host: "none",
                outcome: msg,
                outcomeAt,
              }
        );
      } catch (e) {
        // The retry-with-backoff in writeRecordSync's rename step (Fix 1)
        // resolves the common transient case; if every retry is still
        // exhausted, the outcome never reached disk at all -- and a
        // controller's `wait` after this process exits would then answer
        // "no canvas <id>" for a user who already made a choice. A canvas
        // must still exit 0, so this cannot throw out of an event handler,
        // but silently logging to a file nobody reads is exactly how this
        // failure went unnoticed before: it is now also written to stderr,
        // a channel a human or a wrapping process can actually see.
        const message = `failed to persist outcome: ${(e as Error).message}`;
        process.stderr.write(`${message}\n`);
        void logToFile(id, message);
      }
      send(msg);
    },
    [id, kind, scenario, send]
  );

  return {
    isConnected,
    sendSelected: useCallback((data: unknown) => emitOutcome({ type: "selected", data }), [emitOutcome]),
    sendCancelled: useCallback((reason?: string) => emitOutcome({ type: "cancelled", reason }), [emitOutcome]),
    sendError: useCallback((message: string) => emitOutcome({ type: "error", message }), [emitOutcome]),
  };
}
