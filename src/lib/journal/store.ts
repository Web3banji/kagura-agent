import type { JournalEvent } from "@/types/journal";
import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate } from "@/lib/db";

const DATA_DIR = path.join(process.cwd(), "data", "journal");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const EVENTS_KEY = "journal:events";

function canUseLocalFs(): boolean {
  return !hasDatabase() && !isProductionRuntime();
}

async function ensureLocalStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(EVENTS_FILE);
  } catch {
    await fs.writeFile(EVENTS_FILE, "[]", "utf8");
  }
}

async function readLegacyEventsFile(): Promise<JournalEvent[] | undefined> {
  try {
    const raw = await fs.readFile(EVENTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as JournalEvent[]) : [];
  } catch {
    return undefined;
  }
}

async function seedEventsIfNeeded(): Promise<void> {
  const existing = await kvGet<JournalEvent[]>(EVENTS_KEY);
  if (Array.isArray(existing)) return;
  const legacy = await readLegacyEventsFile();
  if (Array.isArray(legacy) && legacy.length > 0) {
    await kvMutate<JournalEvent[]>(EVENTS_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
  }
}

/**
 * Journal events are system-owned operational activity records (legacy global data).
 * Raw access must be privileged; non-privileged principals get an empty set.
 */
export async function readJournalEvents(opts?: { privileged?: boolean }): Promise<JournalEvent[]> {
  if (!opts?.privileged) return [];
  if (hasDatabase()) {
    const existing = await kvGet<JournalEvent[]>(EVENTS_KEY);
    if (Array.isArray(existing)) return existing;
    const legacy = await readLegacyEventsFile();
    if (Array.isArray(legacy)) {
      if (legacy.length > 0) {
        try {
          await kvMutate<JournalEvent[]>(EVENTS_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
        } catch {}
      }
      return legacy;
    }
    return [];
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable journal storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureLocalStore();
  const raw = await fs.readFile(EVENTS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw) as JournalEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendJournalEvent(event: JournalEvent): Promise<void> {
  if (hasDatabase()) {
    await seedEventsIfNeeded();
    await kvMutate<JournalEvent[]>(EVENTS_KEY, (current) => {
      const events = Array.isArray(current) ? current : [];
      return [event, ...events];
    });
    return;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable journal storage is not configured (DATABASE_URL missing in production).");
  }
  const events = await readJournalEvents();
  events.unshift(event);
  await fs.writeFile(EVENTS_FILE, JSON.stringify(events, null, 2), "utf8");
}