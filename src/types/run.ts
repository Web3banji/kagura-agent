export type AgentRunStatus = "running" | "completed" | "failed" | "blocked" | "incomplete";
export type AgentStage = "OBSERVE" | "ANALYSE" | "VERIFY" | "WRITE" | "REVIEW" | "PUBLISH";

export interface StageRecord {
  stage: AgentStage;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "blocked" | "incomplete";
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
  /**
   * Authenticated principal that initiated this run (when available).
   * Legacy/pre-auth runs have this unset; access is still gated by the existing
   * workspace/legacy-data authorization checks in the API routes.
   */
  userId?: string | null;
  observation?: { repo: string; source: string; newCount: number; totalFetched: number };
  verificationId?: string;
  verificationOutcome?: string;
  draftId?: string;
  publishedStoryId?: string;
  error?: string;
}