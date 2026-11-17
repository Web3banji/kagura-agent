export type AgentRunStatus = "running" | "completed" | "failed";
export type AgentStage = "OBSERVE" | "ANALYSE" | "VERIFY" | "WRITE" | "REVIEW" | "PUBLISH";

export interface StageRecord {
  stage: AgentStage;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  error?: string;
}

export interface AgentRun {
  id: string;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  currentStage: AgentStage;
  stages: StageRecord[];
  trigger: "manual" | "observe";
  observation?: { repo: string; source: string; newCount: number; totalFetched: number };
  verificationId?: string;
  verificationOutcome?: string;
  draftId?: string;
  publishedStoryId?: string;
  error?: string;
}