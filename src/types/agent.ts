export type PipelineRunState = "idle" | "running" | "completed" | "failed";

export interface PipelineState {
  agentState: PipelineRunState;
  stage: "OBSERVE" | "ANALYSE" | "VERIFY" | "WRITE" | "REVIEW" | "PUBLISH";
  note: string;
  lastRunAt?: string;
  lastOutcome?: "success" | "failed" | "blocked";
  lastError?: string;
  lastVerificationId?: string;
  lastDraftId?: string;
}