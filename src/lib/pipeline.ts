import { promises as fs } from "fs";
import path from "path";
import type { PipelineState } from "@/types/agent";

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

const defaultState: PipelineState = {
  agentState: "idle",
  stage: "OBSERVE",
  note: "Ready. No autonomous pipeline run has been executed yet.",
};

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

export async function getCurrentPipelineState(): Promise<PipelineState> {
  await ensure();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...defaultState, ...(JSON.parse(raw) as Partial<PipelineState>) };
  } catch {
    return { ...defaultState };
  }
}

export async function setPipelineState(patch: Partial<PipelineState>): Promise<PipelineState> {
  const current = await getCurrentPipelineState();
  const next = { ...current, ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}