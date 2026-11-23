export type InvestigationStatus = "open" | "resolved" | "superseded";

export type InvestigationCategory =
  | "ui-non-determinism"
  | "navigation-failure"
  | "verification-failure"
  | "environment-issue"
  | "other";

export interface InvestigationVerificationReference {
  verificationId: string;
  jobId?: string;
  outcome: string;
  detectedAt: string;
  evidencePath?: string;
  failingStep?: string;
  summary?: string;
}

export interface Investigation {
  id: string;
  ownerUserId: string;
  projectId?: string | null;
  repositoryConnectionId?: string | null;
  title: string;
  category?: InvestigationCategory | null;
  technicalExplanation: string;
  simpleExplanation: string;
  rootCause?: string | null;
  affectedAreas?: string[] | null;
  expectedBehaviour?: string | null;
  actualBehaviour?: string | null;
  severity?: "low" | "medium" | "high" | "critical" | null;
  status: InvestigationStatus;
  firstDetectedAt: string;
  lastDetectedAt: string;
  verificationReferences: InvestigationVerificationReference[];
  evidenceReferences?: string[] | null;
  aiFixPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvestigationInput {
  ownerUserId: string;
  projectId?: string | null;
  repositoryConnectionId?: string | null;
  title: string;
  category?: InvestigationCategory | null;
  technicalExplanation: string;
  simpleExplanation: string;
  rootCause?: string | null;
  affectedAreas?: string[] | null;
  expectedBehaviour?: string | null;
  actualBehaviour?: string | null;
  severity?: "low" | "medium" | "high" | "critical" | null;
  status?: InvestigationStatus;
  verificationReferences?: InvestigationVerificationReference[];
  evidenceReferences?: string[] | null;
  aiFixPrompt?: string | null;
}

export interface UpdateInvestigationInput {
  title?: string;
  category?: InvestigationCategory | null;
  technicalExplanation?: string;
  simpleExplanation?: string;
  rootCause?: string | null;
  affectedAreas?: string[] | null;
  expectedBehaviour?: string | null;
  actualBehaviour?: string | null;
  severity?: "low" | "medium" | "high" | "critical" | null;
  status?: InvestigationStatus;
  verificationReferences?: InvestigationVerificationReference[];
  evidenceReferences?: string[] | null;
  aiFixPrompt?: string | null;
}
