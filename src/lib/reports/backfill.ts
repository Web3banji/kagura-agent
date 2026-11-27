import type { VerificationRecord } from "@/types/verification";
import type { RecordScope } from "@/lib/auth/scope";
import { ensureDb, getPool, hasDatabase } from "@/lib/db";
import { getStoryById } from "@/lib/stories/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { ensureVerificationReport, verificationReportId } from "./store";

export type VerificationReportBackfillStatus = "would_create" | "created" | "exists" | "skipped" | "invalid" | "failed";

export type VerificationReportBackfillResult = {
  dryRun: boolean;
  eligible: number;
  existing: number;
  skipped: number;
  created: number;
  wouldCreate: number;
  invalid: number;
  failed: number;
  records: Array<{ verificationId: string; jobId?: string; projectId?: string; status: VerificationReportBackfillStatus; error?: string }>;
};

function isTerminal(record: VerificationRecord): boolean {
  return record.outcome !== "pending" && record.outcome !== "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readAllRecords(): Promise<VerificationRecord[]> {
  if (!hasDatabase()) {
    return readVerificationRecords({ includeLegacy: true });
  }
  await ensureDb();
  const projectRes = await getPool().query("SELECT id FROM projects");
  const projectIds = (projectRes.rows as Array<{ id: string }>).map((row) => String(row.id));
  const byId = new Map<string, VerificationRecord>();
  for (const projectId of [undefined, ...projectIds]) {
    const records = await readVerificationRecords({ projectId, includeLegacy: true });
    for (const record of records) byId.set(record.id, record);
  }
  return Array.from(byId.values());
}

export async function backfillVerificationReports(opts: { apply: boolean }): Promise<VerificationReportBackfillResult> {
  const records = await readAllRecords();
  const result: VerificationReportBackfillResult = {
    dryRun: !opts.apply,
    eligible: 0,
    existing: 0,
    skipped: 0,
    created: 0,
    wouldCreate: 0,
    invalid: 0,
    failed: 0,
    records: [],
  };
  const seen = new Set<string>();

  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);

    if (!isTerminal(record)) {
      result.skipped++;
      result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "skipped" });
      continue;
    }

    const owner = record.requestedBy?.trim();
    if (!owner) {
      const message = "verification report cannot be created: owner is missing";
      if (opts.apply) {
        result.failed++;
        result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "failed", error: message });
      } else {
        result.invalid++;
        result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "invalid", error: message });
      }
      continue;
    }

    result.eligible++;
    const scope: RecordScope = { userId: owner, privileged: false, includeLegacy: false };
    const id = verificationReportId(record);
    const existing = await getStoryById(id, scope).catch(() => undefined);
    if (existing) {
      result.existing++;
      result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "exists" });
      continue;
    }

    if (!opts.apply) {
      result.wouldCreate++;
      result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "would_create" });
      continue;
    }

    try {
      const story = await ensureVerificationReport(record);
      if (!story) throw new Error("verification report was not created");
      result.created++;
      result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "created" });
    } catch (error) {
      const message = errorMessage(error);
      result.failed++;
      result.records.push({ verificationId: record.id, jobId: record.jobId, projectId: record.projectId, status: "failed", error: message });
    }
  }

  return result;
}