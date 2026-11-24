import type { Story, StoryCommit } from "@/types/story";
import type { VerificationRecord } from "@/types/verification";
import { generateArticle } from "@/lib/ai/provider";
import { randomUUID } from "crypto";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

export interface DraftObservation {
  repo?: string;
  source: "github-api" | "git-local" | "none";
  commits: Array<{ sha: string; shortSha?: string; message: string; date?: string; author?: string; url?: string }>;
  changedFiles: string[];
  summary: string;
  observedAt?: string;
  note?: string;
}

export interface DraftAnalysis {
  focus: string;
  reason: string;
  flow?: string;
}

export async function generateDraft(
  observation: DraftObservation,
  analysis: DraftAnalysis,
  verification: VerificationRecord | null,
  opts?: { userId?: string | null; projectId?: string | null },
): Promise<Story> {
  const now = new Date().toISOString();
  const commits: StoryCommit[] = observation.commits.slice(0, 10).map((c) => ({
    sha: c.sha,
    message: c.message,
    date: c.date,
    author: c.author,
    url: c.url,
  }));
  const changedFiles = observation.changedFiles.slice(0, 40);
  const top = observation.commits[0];
  const titleHint = top ? `Development update: ${top.message}` : "Development update: repository observed";
  const observationSourceLabel =
    observation.source === "github-api"
      ? "GitHub API"
      : observation.source === "git-local"
        ? "local git"
        : "unavailable observation source";
  const subtitleHint = `Evidence-grounded report from ${observationSourceLabel} observation${verification ? ` and a real Kane CLI verification run (${verification.outcome})` : ""}.`;

  const article = await generateArticle({
    titleHint,
    subtitleHint,
    repo: observation.repo,
    observationSource: observation.source,
    observationSummary: observation.summary + (observation.note ? ` Note: ${observation.note}` : ""),
    commits: commits.map((c) => ({ sha: c.sha, message: c.message, date: c.date, author: c.author, url: c.url })),
    changedFiles,
    analysisReason: analysis.reason,
    focus: analysis.focus,
    verification,
  });

  return {
    id: randomUUID(),
    slug: `${slugify(article.title || titleHint)}-${Date.now().toString(36)}`,
    title: article.title,
    subtitle: article.subtitle,
    body: article.body,
    status: "review",
    userId: opts?.userId ?? null,
    projectId: opts?.projectId ?? verification?.projectId ?? null,
    createdAt: now,
    updatedAt: now,
    generationSource: article.source,
    source: {
      repo: observation.repo,
      commits,
      changedFiles,
      observationSummary: observation.summary,
      observationSource: observation.source,
    },
    verification: verification
      ? {
          id: verification.id,
          outcome: verification.outcome,
          exitCode: verification.exitCode,
          summary: verification.summary,
          failingStep: verification.failingStep,
          durationMs: verification.durationMs,
          creditsConsumed: verification.creditsConsumed,
          testUrl: verification.testUrl,
          evidencePath: verification.evidencePath,
          ndjsonPath: verification.ndjsonPath,
          flow: verification.flow,
          url: verification.url,
        }
      : undefined,
    tags: ["development", "kane-cli", analysis.focus],
  };
}