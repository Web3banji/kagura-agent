export type StoryStatus = "draft" | "review" | "published" | "rejected";

export interface StoryCommit {
  sha: string;
  message: string;
  url?: string;
  date?: string;
  author?: string;
}

export interface StoryAiReport {
  provider: string;
  model?: string;
  generatedAt: string;
  body: string;
}

export interface StoryVerificationIssue {
  id: string;
  title: string;
  severity?: string | null;
  status: string;
  simpleExplanation: string;
  technicalExplanation: string;
  affectedAreas?: string[] | null;
  expectedBehaviour?: string | null;
  actualBehaviour?: string | null;
  aiFixPrompt?: string | null;
}

export interface Story {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  body: string;
  status: StoryStatus;
  userId?: string | null;
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  rejectedAt?: string;
  generationSource?: "ai" | "template";
  reportKind?: "verification" | "project";
  aiReport?: StoryAiReport | null;
  source: {
    repo?: string;
    commits: StoryCommit[];
    changedFiles?: string[];
    observationSummary: string;
    observationSource?: "github-api" | "git-local" | "none";
  };
  verification?: {
    id: string;
    outcome: string;
    exitCode?: number;
    summary?: string;
    failingStep?: string;
    durationMs?: number;
    creditsConsumed?: number;
    testUrl?: string;
    evidencePath?: string;
    ndjsonPath?: string;
    flow?: string;
    url?: string;
    issues?: StoryVerificationIssue[];
  };
  tags: string[];
}
