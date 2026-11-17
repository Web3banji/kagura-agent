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
  url?: string;
  outcome: VerificationOutcome;
  exitCode?: number;
  summary?: string;
  failingStep?: string;
  durationMs?: number;
  creditsConsumed?: number;
  evidencePath?: string;
  testUrl?: string;
  sessionDir?: string;
  startedAt: string;
  finishedAt?: string;
  rawEvent?: string;
  notes?: string;
}

export interface KaneRunResult {
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
}