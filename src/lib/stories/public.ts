import type { Story } from "@/types/story";

export type PublicStory = {
  slug: string;
  title: string;
  subtitle: string;
  body: string;
  status: "published";
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  generationSource?: "ai" | "template";
  source: {
    repo?: string;
    commits: Array<{ message: string; date?: string; author?: string }>;
    observationSummary: string;
    observationSource?: "github-api" | "git-local" | "none";
  };
  verification?: {
    outcome: string;
    summary?: string;
    failingStep?: string;
    durationMs?: number;
    flow?: string;
  };
  tags: string[];
};

export function toPublicStory(story: Story): PublicStory | null {
  if (story.status !== "published") return null;
  return {
    slug: story.slug,
    title: story.title,
    subtitle: story.subtitle,
    body: story.body,
    status: "published",
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    publishedAt: story.publishedAt,
    generationSource: story.generationSource,
    source: {
      repo: story.source.repo,
      observationSummary: story.source.observationSummary,
      observationSource: story.source.observationSource,
      commits: (story.source.commits || []).map((c) => ({
        message: c.message,
        date: c.date,
        author: c.author,
      })),
    },
    verification: story.verification
      ? {
          outcome: story.verification.outcome,
          summary: story.verification.summary,
          failingStep: story.verification.failingStep,
          durationMs: story.verification.durationMs,
          flow: story.verification.flow,
        }
      : undefined,
    tags: Array.isArray(story.tags) ? story.tags.filter((t): t is string => typeof t === "string") : [],
  };
}
