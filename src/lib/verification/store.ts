import type { VerificationOutcome, VerificationRecord } from "@/types/verification";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(RECORDS_FILE);
  } catch {
    await fs.writeFile(RECORDS_FILE, "[]", "utf8");
  }
}

export async function readVerificationRecords(): Promise<VerificationRecord[]> {
  await ensureStore();
  const raw = await fs.readFile(RECORDS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw) as VerificationRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeVerificationRecords(records: VerificationRecord[]): Promise<void> {
  await ensureStore();
  await fs.writeFile(RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
}

export async function appendVerificationRecord(record: VerificationRecord): Promise<VerificationRecord> {
  const records = await readVerificationRecords();
  records.unshift(record);
  await writeVerificationRecords(records);
  return record;
}

export async function upsertVerificationRecord(record: VerificationRecord): Promise<VerificationRecord> {
  const records = await readVerificationRecords();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.unshift(record);
  await writeVerificationRecords(records);
  return record;
}

export async function getVerificationRecord(id: string): Promise<VerificationRecord | undefined> {
  return (await readVerificationRecords()).find((r) => r.id === id);
}

export function summarizeOutcome(records: VerificationRecord[]): {
  latest: VerificationOutcome | "none";
  passed: number;
  failed: number;
  blocked: number;
} {
  const passed = records.filter((r) => r.outcome === "passed").length;
  const failed = records.filter((r) => r.outcome === "failed").length;
  const blocked = records.filter((r) => r.outcome === "blocked" || r.outcome === "did_not_start").length;
  return { latest: records[0]?.outcome ?? "none", passed, failed, blocked };
}
