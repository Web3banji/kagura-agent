import type { JournalEvent } from "@/types/journal";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "journal");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(EVENTS_FILE);
  } catch {
    await fs.writeFile(EVENTS_FILE, "[]", "utf8");
  }
}

export async function readJournalEvents(): Promise<JournalEvent[]> {
  await ensureStore();
  const raw = await fs.readFile(EVENTS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw) as JournalEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendJournalEvent(event: JournalEvent): Promise<void> {
  const events = await readJournalEvents();
  events.unshift(event);
  await fs.writeFile(EVENTS_FILE, JSON.stringify(events, null, 2), "utf8");
}