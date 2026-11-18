import { promises as fs } from "fs";
import path from "path";
import type { ObservedCommit, ObservationState } from "@/types/github";
import { hasDatabase, isProductionRuntime, kvGet, kvSet } from "@/lib/db";

const DATA_DIR = path.join(process.cwd(), "data", "github");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const STATE_KEY = "github:observation:state";
const EVENTS_KEY = "github:observation:events";

function canWriteLocalFiles(): boolean {
  return !hasDatabase() && !isProductionRuntime();
}

function canReadLocalFiles(): boolean {
  // In production prefer durable DB; local filesystem is only for local-dev fallback.
  return !isProductionRuntime() || !hasDatabase();
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readLegacyJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readFileState(): Promise<ObservationState> {
  const v = await readLegacyJson<ObservationState>(STATE_FILE);
  return v && typeof v === "object" ? v : {};
}

async function readFileEvents(): Promise<ObservedCommit[]> {
  const v = await readLegacyJson<ObservedCommit[]>(EVENTS_FILE);
  return Array.isArray(v) ? v : [];
}

export async function readObservationState(): Promise<ObservationState> {
  if (hasDatabase()) {
    const db = await kvGet<ObservationState>(STATE_KEY);
    if (db && typeof db === "object" && !Array.isArray(db)) return db;
    // Import legacy local state if present (read-only) to preserve existing history.
    const legacy = await readLegacyJson<ObservationState>(STATE_FILE);
    if (legacy && typeof legacy === "object" && Object.keys(legacy).length > 0) {
      try {
        await kvSet(STATE_KEY, legacy);
      } catch {
        // Best-effort import; still return legacy without discarding it.
      }
      return legacy;
    }
    return (db && typeof db === "object" ? (db as ObservationState) : {}) || {};
  }
  if (canReadLocalFiles()) return readFileState();
  // Production without durable DB: no writable/expected local store.
  return {};
}

export async function writeObservationState(state: ObservationState): Promise<void> {
  if (hasDatabase()) {
    await kvSet(STATE_KEY, state);
    return;
  }
  if (!canWriteLocalFiles()) {
    throw new Error(
      "Durable GitHub storage is not configured (DATABASE_URL missing in production); refusing to write local filesystem state.",
    );
  }
  await ensureDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function readObservedEvents(): Promise<ObservedCommit[]> {
  if (hasDatabase()) {
    const db = await kvGet<ObservedCommit[]>(EVENTS_KEY);
    if (Array.isArray(db)) return db;
    const legacy = await readLegacyJson<ObservedCommit[]>(EVENTS_FILE);
    if (Array.isArray(legacy)) {
      if (legacy.length > 0) {
        try {
          await kvSet(EVENTS_KEY, legacy);
        } catch {
          // Best-effort import; still return legacy without discarding it.
        }
      }
      return legacy;
    }
    return Array.isArray(db) ? db : [];
  }
  if (canReadLocalFiles()) return readFileEvents();
  return [];
}

export async function writeObservedEvents(events: ObservedCommit[]): Promise<void> {
  if (hasDatabase()) {
    await kvSet(EVENTS_KEY, events);
    return;
  }
  if (!canWriteLocalFiles()) {
    throw new Error(
      "Durable GitHub storage is not configured (DATABASE_URL missing in production); refusing to write local filesystem events.",
    );
  }
  await ensureDir();
  await fs.writeFile(EVENTS_FILE, JSON.stringify(events, null, 2), "utf8");
}

export async function mergeObservedCommits(
  incoming: ObservedCommit[],
): Promise<{ merged: ObservedCommit[]; added: ObservedCommit[] }> {
  const existing = await readObservedEvents();
  const bySha = new Map(existing.map((c) => [c.sha, c]));
  const added: ObservedCommit[] = [];
  for (const c of incoming) {
    if (!bySha.has(c.sha)) {
      added.push(c);
      bySha.set(c.sha, c);
    } else {
      // keep existing (may have processed flag/files) but refresh basic fields if missing
      const prev = bySha.get(c.sha)!;
      bySha.set(c.sha, { ...prev, files: prev.files?.length ? prev.files : c.files, message: prev.message || c.message });
    }
  }
  const merged = Array.from(bySha.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  await writeObservedEvents(merged);
  return { merged, added };
}

export async function markCommitsProcessed(shas: string[]): Promise<void> {
  if (!shas.length) return;
  const events = await readObservedEvents();
  const set = new Set(shas);
  let changed = false;
  for (const e of events) {
    if (set.has(e.sha) && !e.processed) {
      e.processed = true;
      changed = true;
    }
  }
  if (changed) await writeObservedEvents(events);
}

export async function getUnprocessedCommits(limit = 10): Promise<ObservedCommit[]> {
  const events = await readObservedEvents();
  return events.filter((e) => !e.processed).slice(0, limit);
}
