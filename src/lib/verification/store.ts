import type { VerificationOutcome, VerificationRecord } from "@/types/verification";
import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, isProductionRuntime, kvGet, kvSet } from "@/lib/db";
import { AccessDeniedError } from "@/lib/auth/scope";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const LEGACY_RECORDS_FILE = path.join(DATA_DIR, "records.json");

function recordsKey(projectId?: string) {
  return `verification:records:${projectId || "default"}`;
}

function canUseLocalFs(): boolean {
  return !hasDatabase() && !isProductionRuntime();
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
  if (!canUseLocalFs()) return [];
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
  if (!canUseLocalFs()) {
    throw new Error("Durable verification record storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureDir();
  await fs.writeFile(LEGACY_RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
}

export async function readVerificationRecords(opts?: { projectId?: string; requestedBy?: string; includeLegacy?: boolean }): Promise<VerificationRecord[]> {
  const projectId = opts?.projectId;
  const requestedBy = opts?.requestedBy;
  const includeLegacy = opts?.includeLegacy === true;
  let records: VerificationRecord[];
  if (hasDatabase()) {
    const primary = await readDbRecords(projectId);
    const legacy = includeLegacy ? await readLegacyVerificationRecords() : [];
    records = mergeUnique(primary, legacy);
  } else {
    records = includeLegacy ? await readLegacyVerificationRecords() : await readFileRecords();
  }
  return records.filter((r) => matchesRecordScope(r, { projectId, requestedBy, includeLegacy }));
}

/**
 * Fails closed. A principal constrained to its own identity never sees records owned
 * by someone else, and only sees ownerless (legacy/platform) records when
 * `includeLegacy` is explicitly granted.
 */
function matchesRecordScope(
  record: VerificationRecord,
  opts: { projectId?: string; requestedBy?: string; includeLegacy: boolean },
): boolean {
  if (opts.projectId) {
    if (record.projectId && record.projectId !== opts.projectId) return false;
    if (!record.projectId && !opts.includeLegacy) return false;
  }
  if (opts.requestedBy) {
    if (record.requestedBy && record.requestedBy !== opts.requestedBy) return false;
    if (!record.requestedBy && !opts.includeLegacy) return false;
  }
  return true;
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

/**
 * Insert or replace a verification record.
 *
 * When `opts.expectOwner` is supplied (the runner passes the owner recorded on the
 * claimed job), the stored owner is authoritative: a record owned by a different
 * principal can never be overwritten, and a create can never assign a different
 * owner. This prevents a completion payload from re-attributing a record.
 */
export async function upsertVerificationRecord(
  record: VerificationRecord,
  opts?: { expectOwner?: string },
): Promise<VerificationRecord> {
  const projectId = record.projectId;
  const expectOwner = typeof opts?.expectOwner === "string" && opts.expectOwner ? opts.expectOwner : undefined;

  const merge = (existing: VerificationRecord | undefined, incoming: VerificationRecord): VerificationRecord => {
    if (existing) {
      const existingOwner = existing.requestedBy ?? undefined;
      if (expectOwner && existingOwner && existingOwner !== expectOwner) {
        throw new AccessDeniedError("Verification record is owned by another principal");
      }
      // Never allow the owner to be changed by a completion payload.
      const owner = expectOwner ?? existingOwner ?? incoming.requestedBy;
      return { ...existing, ...incoming, requestedBy: owner };
    }
    if (expectOwner && incoming.requestedBy && incoming.requestedBy !== expectOwner) {
      throw new AccessDeniedError("Verification record owner does not match the claimed job");
    }
    return { ...incoming, requestedBy: expectOwner ?? incoming.requestedBy };
  };

  if (hasDatabase()) {
    const records = await readDbRecords(projectId);
    const idx = records.findIndex((r) => r.id === record.id || (record.jobId && r.jobId === record.jobId));
    if (idx >= 0) records[idx] = merge(records[idx], record);
    else records.unshift(merge(undefined, record));
    await writeDbRecords(records, projectId);
    return record;
  }
  const records = await readFileRecords();
  const idx = records.findIndex((r) => r.id === record.id || (record.jobId && r.jobId === record.jobId));
  if (idx >= 0) records[idx] = merge(records[idx], record);
  else records.unshift(merge(undefined, record));
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
