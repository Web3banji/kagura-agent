import { promises as fs } from "fs";
import path from "path";
import type { AgentRun, AgentRunStatus, AgentStage, StageRecord } from "@/types/run";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate, getPool, ensureDb } from "@/lib/db";
import type { RecordScope } from "@/lib/auth/scope";
import { canAccessOwnedRecord, filterVisible } from "@/lib/auth/scope";

const DATA_DIR = path.join(process.cwd(), "data", "agent");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");
const RUNS_KEY = "agent:runs";
const MAX_RUNS = 1000;

function canUseLocalFs(): boolean {
  // Preserve local-dev filesystem workflow; never write deployment-local paths in production.
  return !hasDatabase() && !isProductionRuntime();
}

async function ensureLocal(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(RUNS_FILE);
  } catch {
    await fs.writeFile(RUNS_FILE, "[]", "utf8");
  }
}

async function readLegacyRunsFile(): Promise<AgentRun[] | undefined> {
  try {
    const raw = await fs.readFile(RUNS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as AgentRun[]).slice(0, MAX_RUNS);
  } catch {
    return undefined;
  }
}

async function seedRunsFromLegacyIfNeeded(): Promise<void> {
  const existing = await kvGet<AgentRun[]>(RUNS_KEY);
  if (Array.isArray(existing)) return;
  const legacy = await readLegacyRunsFile();
  if (Array.isArray(legacy) && legacy.length > 0) {
    // Preserve existing run history without overwriting concurrent DB writes.
    await kvMutate<Record<string, AgentRun>>(RUNS_KEY, (cur) =>
      cur && typeof cur === "object" && !Array.isArray(cur) && Object.keys(cur).length > 0 ? cur : Object.fromEntries(legacy.map((r) => [r.id, r])),
    );
  }
}

async function readRunsDb(): Promise<AgentRun[]> {
  const existing = await kvGet<unknown>(RUNS_KEY);
  if (Array.isArray(existing)) return existing as AgentRun[];
  if (existing && typeof existing === "object") return Object.values(existing as Record<string, AgentRun>);
  const legacy = await readLegacyRunsFile();
  if (Array.isArray(legacy)) {
    if (legacy.length > 0) {
      try {
        await kvMutate<Record<string, AgentRun>>(RUNS_KEY, (cur) =>
          cur && typeof cur === "object" && !Array.isArray(cur) ? cur : Object.fromEntries(legacy.map((r) => [r.id, r])),
        );
      } catch {
        // Best-effort import; return legacy without discarding it.
      }
    }
    return legacy;
  }
  return [];
}

export async function readRuns(scope?: RecordScope): Promise<AgentRun[]> {
  const runs = hasDatabase()
    ? await readRunsDb()
    : await (async () => {
        if (!canUseLocalFs()) {
          throw new Error("Durable agent run storage is not configured (DATABASE_URL missing in production).");
        }
        await ensureLocal();
        try {
          const raw = await fs.readFile(RUNS_FILE, "utf8");
          const parsed = JSON.parse(raw) as AgentRun[];
          return Array.isArray(parsed) ? parsed.slice(0, MAX_RUNS) : [];
        } catch {
          return [];
        }
      })();
  return scope ? filterVisible(runs, scope) : runs;
}

export async function writeRuns(runs: AgentRun[]): Promise<void> {
  const capped = runs.slice(0, MAX_RUNS);
  if (hasDatabase()) {
    await seedRunsFromLegacyIfNeeded();
    await kvMutate<Record<string, AgentRun>>(RUNS_KEY, () => Object.fromEntries(capped.map((r) => [r.id, r])));
    return;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable agent run storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureLocal();
  await fs.writeFile(RUNS_FILE, JSON.stringify(capped, null, 2), "utf8");
}

export async function getActiveRun(scope?: RecordScope): Promise<AgentRun | undefined> {
  // Default remains the global single-run invariant (preserves existing behaviour).
  // Pass a scope for strict per-user visibility.
  const runs = await readRuns(scope);
  return runs.find((r) => r.status === "running");
}

export function makeStages(): StageRecord[] {
  const stages: AgentStage[] = ["OBSERVE", "ANALYSE", "VERIFY", "WRITE", "REVIEW", "PUBLISH"];
  return stages.map((stage) => ({ stage, status: "pending" }));
}

export async function createRun(trigger: "manual" | "observe", opts?: { userId?: string | null }): Promise<AgentRun> {
  const run: AgentRun = {
    id: crypto.randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    currentStage: "OBSERVE",
    stages: makeStages(),
    trigger,
    userId: opts?.userId ?? null,
  };
  if (hasDatabase()) {
    await seedRunsFromLegacyIfNeeded();
    await kvMutate<AgentRun[]>(RUNS_KEY, (current) => {
      const base = Array.isArray(current) ? current : [];
      return [run, ...base];
    });
    return run;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable agent run storage is not configured (DATABASE_URL missing in production).");
  }
  const runs = await readRuns();
  runs.unshift(run);
  await writeRuns(runs);
  return run;
}



export async function readAllAgentRuns(): Promise<AgentRun[]> {
  if (hasDatabase()) {
    await seedRunsFromLegacyIfNeeded();
    const existing = await kvGet<unknown>(RUNS_KEY);
    if (Array.isArray(existing)) return existing as AgentRun[];
    if (existing && typeof existing === "object") return Object.values(existing as Record<string, AgentRun>);
    return [];
  }
  if (!canUseLocalFs()) return [];
  await ensureLocal();
  try {
    const raw = await fs.readFile(RUNS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as AgentRun[];
    if (parsed && typeof parsed === "object") return Object.values(parsed as Record<string, AgentRun>);
    return [];
  } catch {
    return [];
  }
}

export async function findAgentRunsByVerificationId(verificationId: string): Promise<AgentRun[]> {
  if (!verificationId) return [];
  const runs = await readAllAgentRuns();
  return runs.filter((r) => r.verificationId === verificationId);
}

export async function findAgentRunByVerificationId(verificationId: string): Promise<AgentRun | undefined> {
  const matches = await findAgentRunsByVerificationId(verificationId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function mapVerificationOutcomeToAgentRunStatus(outcome: string): { runStatus: AgentRunStatus; stageStatus: StageRecord["status"]; terminal: boolean } | null {
  switch (outcome) {
    case "passed":
      return { runStatus: "completed", stageStatus: "completed", terminal: true };
    case "failed":
      return { runStatus: "failed", stageStatus: "failed", terminal: true };
    case "blocked":
      return { runStatus: "blocked", stageStatus: "blocked", terminal: true };
    case "did_not_start":
    case "timeout":
      return { runStatus: "incomplete", stageStatus: "incomplete", terminal: true };
    default:
      return null;
  }
}


export async function reconcilePipelineStateForVerification(verificationId: string, outcome: string, summary?: string): Promise<void> {
  const mapped = mapVerificationOutcomeToAgentRunStatus(outcome);
  if (!mapped) return;
  const { getCurrentPipelineState, setPipelineState } = await import("@/lib/pipeline");
  const current = await getCurrentPipelineState();
  if (current.lastVerificationId !== verificationId) return;
  const agentState = mapped.runStatus === "completed" ? "completed" : "failed";
  const lastOutcome = mapped.runStatus === "completed"
    ? "success"
    : outcome === "blocked" || outcome === "did_not_start"
      ? "blocked"
      : "failed";
  const terminalError = mapped.runStatus === "completed" ? undefined : (summary || current.lastError);
  await setPipelineState({
    agentState,
    stage: "VERIFY",
    note: summary || current.note,
    lastOutcome,
    lastError: terminalError,
    lastVerificationId: verificationId,
  });
}

export async function reconcileAgentRunForVerification(
  verificationId: string,
  outcome: string,
  summary?: string,
): Promise<{ updated: boolean; reason: string; runId?: string }> {
  if (!verificationId) return { updated: false, reason: "missing_verification_id" };
  const mapped = mapVerificationOutcomeToAgentRunStatus(outcome);
  if (!mapped) return { updated: false, reason: "nonterminal_outcome" };

  await reconcilePipelineStateForVerification(verificationId, outcome, summary).catch(() => undefined);

  const matches = await findAgentRunsByVerificationId(verificationId);
  if (matches.length === 0) return { updated: false, reason: "no_associated_run" };
  if (matches.length > 1) return { updated: false, reason: "ambiguous_association" };
  const run = matches[0];
  if (run.verificationId !== verificationId) return { updated: false, reason: "verification_id_mismatch", runId: run.id };

  if (run.status !== "running") {
    if (run.status === mapped.runStatus && run.verificationOutcome === outcome) {
      return { updated: false, reason: "already_reconciled", runId: run.id };
    }
    return { updated: false, reason: "run_already_terminal", runId: run.id };
  }

  const updated = await updateRun(run.id, {
    status: mapped.runStatus,
    verificationOutcome: outcome,
    currentStage: "VERIFY",
    finishedAt: new Date().toISOString(),
    error: mapped.runStatus === "completed" ? run.error : (summary || run.error),
    stageUpdate: { stage: "VERIFY", status: mapped.stageStatus, note: summary },
  });
  if (!updated) return { updated: false, reason: "update_failed", runId: run.id };
  return { updated: true, reason: "reconciled", runId: run.id };
}

export async function readAllVerificationRecordsForReconciliation(): Promise<Array<{ id: string; jobId?: string; outcome: string; summary?: string }>> {
  const out: Array<{ id: string; jobId?: string; outcome: string; summary?: string }> = [];
  if (hasDatabase()) {
    await ensureDb();
    const pool = getPool();
    const keys = await pool.query("SELECT value FROM echolog_kv WHERE key LIKE 'verification:records:%'");
    for (const row of keys.rows) {
      const arr = Array.isArray(row.value) ? row.value : [];
      for (const r of arr) {
        if (r && typeof r.id === "string" && typeof r.outcome === "string") {
          out.push({ id: r.id, jobId: typeof r.jobId === "string" ? r.jobId : undefined, outcome: r.outcome, summary: typeof r.summary === "string" ? r.summary : undefined });
        }
      }
    }
    return out;
  }
  if (!canUseLocalFs()) return out;
  await fs.mkdir(path.join(process.cwd(), "data", "verification"), { recursive: true });
  const recordsFile = path.join(process.cwd(), "data", "verification", "records.json");
  try {
    const raw = await fs.readFile(recordsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) for (const r of parsed) if (r?.id && r?.outcome) out.push({ id: r.id, jobId: r.jobId, outcome: r.outcome, summary: r.summary });
  } catch {}
  const dir = path.join(process.cwd(), "data", "verification", "records");
  try {
    const files = await fs.readdir(dir);
    for (const f of files.filter(x => x.endsWith(".json"))) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const r = JSON.parse(raw);
        if (r?.id && r?.outcome) out.push({ id: r.id, jobId: r.jobId, outcome: r.outcome, summary: r.summary });
      } catch {}
    }
  } catch {}
  return out;
}

export async function reconcilePendingAgentRuns(): Promise<{ processed: number; failed: number; skipped: number; items: Array<{ id: string; status: string; reason?: string }> }> {
  const result = { processed: 0, failed: 0, skipped: 0, items: [] as Array<{ id: string; status: string; reason?: string }> };
  const records = await readAllVerificationRecordsForReconciliation();
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const record of records) {
    if (record.outcome === "pending" || record.outcome === "running") {
      result.skipped++;
      continue;
    }
    const verificationId = record.jobId || record.id;
    try {
      const recon = await reconcileAgentRunForVerification(verificationId, record.outcome, record.summary);
      if (recon.updated) result.processed++;
      else result.skipped++;
      result.items.push({ id: verificationId, status: recon.updated ? "reconciled" : "skipped", reason: recon.reason });
    } catch (err) {
      result.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      result.items.push({ id: verificationId, status: "failed", reason });
      diagnostics.push({ agentRunId: undefined, verificationJobId: verificationId, attemptCount: 1, lastAttemptAt: new Date().toISOString(), errorCategory: "reconciliation_error", lastError: reason, retryStatus: "retryable" });
    }
  }
  if (diagnostics.length > 0) {
    const key = "agent:reconciliation:diagnostics";
    const existing = hasDatabase() ? await kvGet<Array<Record<string, unknown>>>(key) : null;
    const next = Array.isArray(existing) ? [...existing, ...diagnostics].slice(-100) : diagnostics;
    if (hasDatabase()) await kvMutate<Array<Record<string, unknown>>>(key, () => next);
    else {
      const file = path.join(process.cwd(), "data", "agent", "reconciliation-diagnostics.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
    }
  }
  return result;
}
export async function recoverStaleAgentRunForVerification(
  runId: string,
  verificationId: string,
): Promise<{ updated: boolean; reason: string; runId?: string }> {
  const runs = await readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { updated: false, reason: "run_not_found" };
  if (run.verificationId !== verificationId) return { updated: false, reason: "verification_id_mismatch", runId: run.id };

  const { getJob } = await import("@/lib/verification/jobs");
  const job = await getJob(verificationId);
  if (!job) return { updated: false, reason: "verification_job_not_found", runId: run.id };
  const outcome = job.result?.outcome || (job.status === "completed" ? "passed" : job.status === "failed" ? "failed" : job.status === "did_not_start" ? "did_not_start" : "pending");
  const mapped = mapVerificationOutcomeToAgentRunStatus(outcome);
  if (!mapped) return { updated: false, reason: "verification_not_terminal", runId: run.id };

  return reconcileAgentRunForVerification(verificationId, outcome, job.result?.summary || job.error);
}

export async function updateRun(
  id: string,
  patch: Partial<AgentRun> & {
    stageUpdate?: { stage: AgentStage; status: StageRecord["status"]; note?: string; error?: string };
  },
  scope?: RecordScope,
): Promise<AgentRun | undefined> {
  const apply = (runs: AgentRun[]): { next: AgentRun[]; updated?: AgentRun } => {
    const idx = runs.findIndex((r) => r.id === id);
    if (idx < 0) return { next: runs };
    if (scope && !canAccessOwnedRecord(runs[idx].userId, scope)) {
      return { next: runs };
    }
    // A non-privileged principal may never reassign the owner of an existing run.
    const run = { ...runs[idx], ...patch };
    // A non-privileged principal may never reassign the owner of an existing run.
    if (!scope || !scope.privileged) {
      run.userId = runs[idx].userId;
    }
    if (patch.stageUpdate) {
      const su = patch.stageUpdate;
      run.stages = run.stages.map((s) => {
        if (s.stage !== su.stage) return s;
        const next: StageRecord = { ...s, status: su.status, note: su.note ?? s.note, error: su.error };
        if (su.status === "running" && !s.startedAt) next.startedAt = new Date().toISOString();
        if (su.status === "completed" || su.status === "failed" || su.status === "skipped") {
          next.finishedAt = new Date().toISOString();
        }
        return next;
      });
    }
    const next = [...runs];
    next[idx] = run;
    return { next, updated: run };
  };

  if (hasDatabase()) {
    await seedRunsFromLegacyIfNeeded();
    let updated: AgentRun | undefined;
    await kvMutate<AgentRun[]>(RUNS_KEY, (current) => {
      const base = Array.isArray(current) ? current : [];
      const res = apply(base);
      updated = res.updated;
      return res.next;
    });
    return updated;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable agent run storage is not configured (DATABASE_URL missing in production).");
  }
  const runs = await readRuns();
  const res = apply(runs);
  if (!res.updated) return undefined;
  await writeRuns(res.next);
  return res.updated;
}