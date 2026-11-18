import { enqueueJob } from "@/lib/verification/jobs";
import { appendVerificationRecord } from "@/lib/verification/store";
import { readGitHubConfig, repoSlug } from "@/lib/github/config";
import type { VerificationRecord } from "@/types/verification";
import type { Analysis } from "./analyse";

export async function verifyWithKane(
  analysis: Analysis,
  opts?: { source?: "local" | "runner"; jobId?: string; projectId?: string; requestedBy?: string },
): Promise<VerificationRecord> {
  const url = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || "http://localhost:3000";
  let projectId = opts?.projectId;
  if (!projectId) {
    try {
      const cfg = await readGitHubConfig();
      projectId = repoSlug(cfg) || "default";
    } catch {
      projectId = "default";
    }
  }
  const startedAt = new Date().toISOString();
  const job = await enqueueJob({
    id: opts?.jobId,
    flow: analysis.flow,
    objective: analysis.objective,
    url,
    projectId,
    requestedBy: opts?.requestedBy,
    headless: true,
    timeout: 180,
    reason: "pipeline",
  });

  const record: VerificationRecord = {
    id: job.id,
    flow: analysis.flow,
    objective: analysis.objective,
    url,
    outcome: "pending",
    summary: "Verification job queued for shared local runner. Awaiting genuine Kane CLI execution and synced results.",
    startedAt,
    source: opts?.source || "runner",
    jobId: job.id,
    projectId,
    requestedBy: opts?.requestedBy,
    notes: "Kane CLI is never executed on the hosting server.",
  };
  await appendVerificationRecord(record);
  return record;
}
