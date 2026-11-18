import { promises as fs } from "fs";
import path from "path";
import type { AgentRun, AgentStage, StageRecord } from "@/types/run";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate } from "@/lib/db";
import type { RecordScope } from "@/lib/auth/scope";
import { canAccessOwnedRecord, filterVisible } from "@/lib/auth/scope";

const DATA_DIR = path.join(process.cwd(), "data", "agent");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");
const RUNS_KEY = "agent:runs";
const MAX_RUNS = 50;

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
    await kvMutate<AgentRun[]>(RUNS_KEY, (cur) =>
      Array.isArray(cur) && cur.length > 0 ? cur : legacy.slice(0, MAX_RUNS),
    );
  }
}

async function readRunsDb(): Promise<AgentRun[]> {
  const existing = await kvGet<AgentRun[]>(RUNS_KEY);
  if (Array.isArray(existing)) return existing.slice(0, MAX_RUNS);
  const legacy = await readLegacyRunsFile();
  if (Array.isArray(legacy)) {
    if (legacy.length > 0) {
      try {
        await kvMutate<AgentRun[]>(RUNS_KEY, (cur) =>
          Array.isArray(cur) && cur.length > 0 ? cur : legacy.slice(0, MAX_RUNS),
        );
      } catch {
        // Best-effort import; return legacy without discarding it.
      }
    }
    return legacy.slice(0, MAX_RUNS);
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
    await kvMutate<AgentRun[]>(RUNS_KEY, () => capped);
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
      return [run, ...base].slice(0, MAX_RUNS);
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
      return res.next.slice(0, MAX_RUNS);
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