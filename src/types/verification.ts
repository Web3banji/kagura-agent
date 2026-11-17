export type VerificationOutcome =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "did_not_start"
  | "timeout";

export interface VerificationRecord {
  id: string;
  flow: string;
  objective: string;
  command?: string;
  url?: string;
  chromeProfile?: string;
  outcome: VerificationOutcome;
  exitCode?: number;
  summary?: string;
  failingStep?: string;
  durationMs?: number;
  creditsConsumed?: number;
  evidencePath?: string;
  testUrl?: string;
  sessionDir?: string;
  ndjsonPath?: string;
  runEnd?: Record<string, unknown>;
  stderr?: string;
  startedAt: string;
  finishedAt?: string;
  source?: "local" | "runner";
  jobId?: string;
  notes?: string;
}

export interface KaneRunResult {
  id?: string;
  outcome: VerificationOutcome;
  exitCode: number | null;
  summary?: string;
  failingStep?: string;
  durationMs?: number;
  creditsConsumed?: number;
  evidencePath?: string;
  testUrl?: string;
  sessionDir?: string;
  runEnd?: Record<string, unknown>;
  stderr?: string;
  ndjsonPath?: string;
  command?: string;
  flow?: string;
  objective?: string;
  url?: string;
}

export interface VerificationJob {
  id: string;
  status: "pending" | "claimed" | "running" | "completed" | "failed";
  flow: string;
  objective: string;
  url: string;
  chromeProfile?: string;
  headless?: boolean;
  timeout?: number;
  reason?: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  recordId?: string;
  error?: string;
}
