import { promises as fs } from "fs";
import path from "path";
import type { PipelineState } from "@/types/agent";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate } from "@/lib/db";

export const PIPELINE_STAGES = [
  "OBSERVE",
  "ANALYSE",
  "VERIFY",
  "WRITE",
  "REVIEW",
  "PUBLISH",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const DATA_DIR = path.join(process.cwd(), "data", "agent");
const STATE_FILE = path.join(DATA_DIR, "pipeline-state.json");
const STATE_KEY = "agent:pipeline-state";

const defaultState: PipelineState = {
  agentState: "idle",
  stage: "OBSERVE",
  note: "Ready. No autonomous pipeline run has been executed yet.",
};

function canUseLocalFs(): boolean {
  return !hasDatabase() && !isProductionRuntime();
}

async function ensureLocal() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

async function readLegacyStateFile(): Promise<Partial<PipelineState> | undefined> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PipelineState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return undefined;
  }
}

function normalizeState(current: unknown): PipelineState {
  if (!current || typeof current !== "object" || Array.isArray(current)) return { ...defaultState };
  return { ...defaultState, ...(current as Partial<PipelineState>) };
}

async function seedStateFromLegacyIfNeeded(): Promise<void> {
  const existing = await kvGet<PipelineState>(STATE_KEY);
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return;
  const legacy = await readLegacyStateFile();
  if (legacy && Object.keys(legacy).length > 0) {
    await kvMutate<PipelineState>(STATE_KEY, (cur) => {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) return normalizeState(cur);
      return normalizeState(legacy);
    });
  }
}

export async function getCurrentPipelineState(): Promise<PipelineState> {
  if (hasDatabase()) {
    const existing = await kvGet<PipelineState>(STATE_KEY);
    if (existing && typeof existing === "object" && !Array.isArray(existing)) return normalizeState(existing);
    const legacy = await readLegacyStateFile();
    if (legacy && Object.keys(legacy).length > 0) {
      const merged = normalizeState(legacy);
      try {
        await kvMutate<PipelineState>(STATE_KEY, (cur) =>
          cur && typeof cur === "object" && !Array.isArray(cur) ? normalizeState(cur) : merged,
        );
      } catch {
        // best-effort import
      }
      return merged;
    }
    return { ...defaultState };
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable pipeline state storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureLocal();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...defaultState, ...(JSON.parse(raw) as Partial<PipelineState>) };
  } catch {
    return { ...defaultState };
  }
}

export async function setPipelineState(patch: Partial<PipelineState>): Promise<PipelineState> {
  if (hasDatabase()) {
    await seedStateFromLegacyIfNeeded();
    return kvMutate<PipelineState>(STATE_KEY, (current) => ({ ...normalizeState(current), ...patch }));
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable pipeline state storage is not configured (DATABASE_URL missing in production).");
  }
  const current = await getCurrentPipelineState();
  const next = { ...current, ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}