export type StoryStatus = "draft" | "review" | "published" | "rejected";

export interface StoryCommit {
  sha: string;
  message: string;
  url?: string;
  date?: string;
  author?: string;
}

export interface Story {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  body: string;
  status: StoryStatus;
  userId?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  rejectedAt?: string;
  generationSource?: "ai" | "template";
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
  };
  tags: string[];
}
