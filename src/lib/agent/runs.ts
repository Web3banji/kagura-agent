import { promises as fs } from "fs";
import path from "path";
import type { AgentRun, AgentStage, StageRecord } from "@/types/run";

const DATA_DIR = path.join(process.cwd(), "data", "agent");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(RUNS_FILE); } catch { await fs.writeFile(RUNS_FILE, "[]", "utf8"); }
}

export async function readRuns(): Promise<AgentRun[]> {
  await ensure();
  try {
    const raw = await fs.readFile(RUNS_FILE, "utf8");
    const parsed = JSON.parse(raw) as AgentRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function writeRuns(runs: AgentRun[]): Promise<void> {
  await ensure();
  await fs.writeFile(RUNS_FILE, JSON.stringify(runs.slice(0, 50), null, 2), "utf8");
}

export async function getActiveRun(): Promise<AgentRun | undefined> {
  return (await readRuns()).find((r) => r.status === "running");
}

export function makeStages(): StageRecord[] {
  const stages: AgentStage[] = ["OBSERVE", "ANALYSE", "VERIFY", "WRITE", "REVIEW", "PUBLISH"];
  return stages.map((stage) => ({ stage, status: "pending" }));
}

export async function createRun(trigger: "manual" | "observe"): Promise<AgentRun> {
  const runs = await readRuns();
  const run: AgentRun = {
    id: crypto.randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    currentStage: "OBSERVE",
    stages: makeStages(),
    trigger,
  };
  runs.unshift(run);
  await writeRuns(runs);
  return run;
}

export async function updateRun(id: string, patch: Partial<AgentRun> & { stageUpdate?: { stage: AgentStage; status: StageRecord["status"]; note?: string; error?: string } }): Promise<AgentRun | undefined> {
  const runs = await readRuns();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return undefined;
  const run = { ...runs[idx], ...patch };
  if (patch.stageUpdate) {
    const su = patch.stageUpdate;
    run.stages = run.stages.map((s) => {
      if (s.stage !== su.stage) return s;
      const next: StageRecord = { ...s, status: su.status, note: su.note ?? s.note, error: su.error };
      if (su.status === "running" && !s.startedAt) next.startedAt = new Date().toISOString();
      if (su.status === "completed" || su.status === "failed" || su.status === "skipped") next.finishedAt = new Date().toISOString();
      return next;
    });
  }
  runs[idx] = run;
  await writeRuns(runs);
  return run;
}