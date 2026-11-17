import { promises as fs } from "fs";
import path from "path";
import type { ObservedCommit, ObservationState } from "@/types/github";

const DATA_DIR = path.join(process.cwd(), "data", "github");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readObservationState(): Promise<ObservationState> {
  await ensure();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as ObservationState;
  } catch {
    return {};
  }
}

export async function writeObservationState(state: ObservationState): Promise<void> {
  await ensure();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function readObservedEvents(): Promise<ObservedCommit[]> {
  await ensure();
  try {
    const raw = await fs.readFile(EVENTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as ObservedCommit[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeObservedEvents(events: ObservedCommit[]): Promise<void> {
  await ensure();
  await fs.writeFile(EVENTS_FILE, JSON.stringify(events, null, 2), "utf8");
}

export async function mergeObservedCommits(incoming: ObservedCommit[]): Promise<{ merged: ObservedCommit[]; added: ObservedCommit[] }> {
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