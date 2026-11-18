import type { VerificationOutcome, VerificationRecord } from "@/types/verification";
import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, kvGet, kvSet } from "@/lib/db";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const LEGACY_RECORDS_FILE = path.join(DATA_DIR, "records.json");

function recordsKey(projectId?: string) {
  return `verification:records:${projectId || "default"}`;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readLegacyFile(): Promise<VerificationRecord[]> {
  try {
    const raw = await fs.readFile(LEGACY_RECORDS_FILE, "utf8");
    const parsed = JSON.parse(raw) as VerificationRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readLegacyDir(): Promise<VerificationRecord[]> {
  const dir = path.join(DATA_DIR, "records");
  try {
    const files = await fs.readdir(dir);
    const out: VerificationRecord[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = JSON.parse(raw) as VerificationRecord;
        if (parsed && parsed.id) out.push(parsed);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function readLegacyVerificationRecords(): Promise<VerificationRecord[]> {
  const [a, b] = await Promise.all([readLegacyFile(), readLegacyDir()]);
  const byId = new Map<string, VerificationRecord>();
  for (const r of [...a, ...b]) byId.set(r.id, r);
  return Array.from(byId.values()).sort(
    (x, y) => new Date(y.startedAt || y.finishedAt || 0).getTime() - new Date(x.startedAt || x.finishedAt || 0).getTime(),
  );
}

function mergeUnique(primary: VerificationRecord[], legacy: VerificationRecord[]): VerificationRecord[] {
  const byId = new Map<string, VerificationRecord>();
  for (const r of legacy) byId.set(r.id, r);
  for (const r of primary) byId.set(r.id, r); // primary wins
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.startedAt || b.finishedAt || 0).getTime() - new Date(a.startedAt || a.finishedAt || 0).getTime(),
  );
}

async function readDbRecords(projectId?: string): Promise<VerificationRecord[]> {
  if (!hasDatabase()) return [];
  const key = recordsKey(projectId);
  const list = await kvGet<VerificationRecord[]>(key);
  return Array.isArray(list) ? list : [];
}

async function writeDbRecords(records: VerificationRecord[], projectId?: string): Promise<void> {
  await kvSet(recordsKey(projectId), records.slice(0, 500));
}

async function readFileRecords(): Promise<VerificationRecord[]> {
  await ensureDir();
  try {
    const raw = await fs.readFile(LEGACY_RECORDS_FILE, "utf8");
    const parsed = JSON.parse(raw) as VerificationRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      await fs.writeFile(LEGACY_RECORDS_FILE, "[]", "utf8");
    } catch {}
    return [];
  }
}

async function writeFileRecords(records: VerificationRecord[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(LEGACY_RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
}

export async function readVerificationRecords(opts?: { projectId?: string; requestedBy?: string; includeLegacy?: boolean }): Promise<VerificationRecord[]> {
  const projectId = opts?.projectId;
  const requestedBy = opts?.requestedBy;
  let records: VerificationRecord[];
  if (hasDatabase()) {
    const primary = await readDbRecords(projectId);
    const legacy = opts?.includeLegacy === false ? [] : await readLegacyVerificationRecords();
    records = mergeUnique(primary, legacy);
  } else {
    records = await readFileRecords();
  }
  return records.filter((r) => {
    if (projectId && r.projectId && r.projectId !== projectId) return false;
    if (requestedBy && r.requestedBy && r.requestedBy !== requestedBy) return false;
    return true;
  });
}

export async function writeVerificationRecords(records: VerificationRecord[], projectId?: string): Promise<void> {
  if (hasDatabase()) {
    await writeDbRecords(records, projectId);
    return;
  }
  await writeFileRecords(records);
}

export async function appendVerificationRecord(record: VerificationRecord): Promise<VerificationRecord> {
  const projectId = record.projectId;
  if (hasDatabase()) {
    const records = await readDbRecords(projectId);
    records.unshift(record);
    await writeDbRecords(records, projectId);
    return record;
  }
  const records = await readFileRecords();
  records.unshift(record);
  await writeFileRecords(records);
  return record;
}

export async function upsertVerificationRecord(record: VerificationRecord): Promise<VerificationRecord> {
  const projectId = record.projectId;
  if (hasDatabase()) {
    const records = await readDbRecords(projectId);
    const idx = records.findIndex((r) => r.id === record.id || (record.jobId && r.jobId === record.jobId));
    if (idx >= 0) records[idx] = { ...records[idx], ...record };
    else records.unshift(record);
    await writeDbRecords(records, projectId);
    return record;
  }
  const records = await readFileRecords();
  const idx = records.findIndex((r) => r.id === record.id || (record.jobId && r.jobId === record.jobId));
  if (idx >= 0) records[idx] = { ...records[idx], ...record };
  else records.unshift(record);
  await writeFileRecords(records);
  return record;
}

export async function getVerificationRecord(id: string, opts?: { projectId?: string; requestedBy?: string }): Promise<VerificationRecord | undefined> {
  const all = await readVerificationRecords({ projectId: opts?.projectId, requestedBy: opts?.requestedBy, includeLegacy: true });
  return all.find((r) => r.id === id || r.jobId === id);
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
