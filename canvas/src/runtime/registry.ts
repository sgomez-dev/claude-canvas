import { mkdir, unlink, chmod, readdir } from "node:fs/promises";
import { canvasesDir, recordPath } from "./paths";
import { assertIdent } from "./validate";
export { newToken } from "./token";

export interface CanvasRecord {
  id: string; kind: string; scenario: string;
  port: number; token: string; pid: number;
  startedAt: string; host: string;
  wtSession?: string; lastError?: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeRecord(r: CanvasRecord): Promise<void> {
  assertIdent("id", r.id);
  await mkdir(canvasesDir(), { recursive: true });
  const path = recordPath(r.id);
  await Bun.write(path, JSON.stringify(r, null, 2));
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function readRecord(id: string): Promise<CanvasRecord | null> {
  assertIdent("id", id);
  const file = Bun.file(recordPath(id));
  if (!(await file.exists())) return null;
  let r: CanvasRecord;
  try {
    r = (await file.json()) as CanvasRecord;
  } catch {
    await deleteRecord(id);
    return null;
  }
  // A record with lastError and no live process is still readable, so a
  // failed canvas stays discoverable rather than vanishing silently.
  if (r.lastError) return r;
  if (!isAlive(r.pid)) {
    await deleteRecord(id);
    return null;
  }
  return r;
}

export async function listRecords(): Promise<CanvasRecord[]> {
  let names: string[];
  try {
    names = await readdir(canvasesDir());
  } catch {
    return [];
  }
  const out: CanvasRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // readRecord calls assertIdent internally, which throws on a basename
    // that isn't a valid identifier. A stray/malformed filename in the
    // canvases dir must not take down `list` for every other canvas — skip
    // it rather than let the throw escape.
    let r: CanvasRecord | null;
    try {
      r = await readRecord(name.slice(0, -5));
    } catch {
      continue;
    }
    if (r && !r.lastError) out.push(r);
  }
  return out;
}

export async function deleteRecord(id: string): Promise<void> {
  assertIdent("id", id);
  try {
    await unlink(recordPath(id));
  } catch {
    // already gone
  }
}
