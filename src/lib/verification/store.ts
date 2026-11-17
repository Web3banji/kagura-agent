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

export async function appendVerificationRecord(record: VerificationRecord) {
  const records = await readVerificationRecords();
  records.unshift(record);
  await fs.writeFile(RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
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