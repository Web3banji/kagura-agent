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
  investigationIds?: string[];
  investigationProcessing?: {
    state: "pending" | "processing" | "processed" | "failed";
    processingStartedAt?: string;
    processedAt?: string;
    error?: string;
  };
  notes?: string;
  projectId?: string;
  requestedBy?: string;
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

export type VerificationJobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "did_not_start";

export interface VerificationJobResult {
  exitCode?: number;
  outcome?: VerificationOutcome;
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
  startedAt?: string;
  finishedAt?: string;
}

export interface VerificationJob {
  id: string;
  status: VerificationJobStatus;
  flow: string;
  objective: string;
  url: string;
  projectId?: string;
  requestedBy?: string;
  chromeProfile?: string;
  headless?: boolean;
  timeout?: number;
  reason?: string;
  createdAt: string;
  updatedAt?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  runnerId?: string;
  attempt?: number;
  recordId?: string;
  error?: string;
  result?: VerificationJobResult;
}

export interface RunnerHeartbeat {
  runnerId?: string;
  status: "connected" | "disconnected";
  version?: string;
  lastHeartbeat?: string;
  lastSuccessfulExecution?: string;
  currentJobId?: string;
  pendingJobs?: number;
  note?: string;
}
