import type { Investigation } from "@/types/investigation";
import type { Story, StoryVerificationIssue } from "@/types/story";
import type { VerificationRecord } from "@/types/verification";
import type { RecordScope } from "@/lib/auth/scope";
import { getStoryById, upsertStory } from "@/lib/stories/store";
import { readInvestigations } from "@/lib/investigations/store";

export type ReportPrompt = { id: string; title: string; prompt: string | null };

export function verificationReportId(record: VerificationRecord): string {
  return `verification-report:${record.id}`;
}

function outcomeLabel(outcome: string): string {
  if (outcome === "passed") return "Successful verification";
  if (outcome === "failed") return "Verification found a problem";
  if (outcome === "blocked" || outcome === "did_not_start") return "Verification could not run";
  if (outcome === "timeout") return "Verification timed out";
  return outcome.replace(/_/g, " ");
}

function issueSection(investigations: Investigation[]): string {
  if (investigations.length === 0) {
    return "No confirmed issue records are linked to this verification run.";
  }
  return investigations
    .map((inv) => {
      const lines = [
        `### ${inv.title}`,
        inv.simpleExplanation || inv.technicalExplanation || "No explanation recorded.",
        inv.severity ? `Severity: ${inv.severity}` : null,
        inv.status ? `Status: ${inv.status}` : null,
        inv.affectedAreas?.length ? `Affected areas: ${inv.affectedAreas.join(", ")}` : null,
        inv.expectedBehaviour ? `Expected: ${inv.expectedBehaviour}` : null,
        inv.actualBehaviour ? `Actual: ${inv.actualBehaviour}` : null,
        inv.aiFixPrompt ? `Issue-specific fix prompt: ${inv.aiFixPrompt}` : null,
      ].filter(Boolean);
      return lines.join("\n\n");
    })
    .join("\n\n");
}

function snapshotIssues(investigations: Investigation[]): StoryVerificationIssue[] {
  return investigations.map((inv) => ({
    id: inv.id,
    title: inv.title,
    severity: inv.severity ?? null,
    status: inv.status,
    simpleExplanation: inv.simpleExplanation,
    technicalExplanation: inv.technicalExplanation,
    affectedAreas: inv.affectedAreas ?? null,
    expectedBehaviour: inv.expectedBehaviour ?? null,
    actualBehaviour: inv.actualBehaviour ?? null,
    aiFixPrompt: inv.aiFixPrompt ?? null,
  }));
}

export function resolveReportPrompts(
  report: Story,
  investigations: Investigation[],
  currentRecord?: VerificationRecord | null,
): ReportPrompt[] {
  const snapshot = report.verification?.issues ?? [];
  const linked = currentRecord
    ? investigations.filter((inv) =>
        (report.userId ? inv.ownerUserId === report.userId : !inv.ownerUserId) &&
        (report.projectId ? inv.projectId === report.projectId : !inv.projectId) &&
        (!currentRecord.requestedBy || inv.ownerUserId === currentRecord.requestedBy) &&
        (!currentRecord.projectId || !inv.projectId || inv.projectId === currentRecord.projectId) &&
        inv.verificationReferences.some((ref) => ref.verificationId === currentRecord.id || (currentRecord.jobId && ref.jobId === currentRecord.jobId)),
      )
    : [];
  const liveById = new Map(linked.map((inv) => [inv.id, inv]));

  if (snapshot.length > 0) {
    return snapshot.map((issue) => {
      const live = liveById.get(issue.id);
      const prompt = issue.aiFixPrompt ?? live?.aiFixPrompt ?? null;
      return { id: issue.id, title: issue.title, prompt };
    });
  }

  return linked.map((inv) => ({ id: inv.id, title: inv.title, prompt: inv.aiFixPrompt ?? null }));
}

export function buildVerificationReportBody(record: VerificationRecord, investigations: Investigation[]): string {
  const outcome = outcomeLabel(record.outcome);
  const technical = [
    record.flow ? `Flow: ${record.flow}` : null,
    record.url ? `Target URL: ${record.url}` : null,
    record.exitCode != null ? `Exit code: ${record.exitCode}` : null,
    record.failingStep ? `Failing step: ${record.failingStep}` : null,
    record.durationMs != null ? `Duration: ${(record.durationMs / 1000).toFixed(1)}s` : null,
    record.evidencePath ? `Evidence: ${record.evidencePath}` : null,
    record.testUrl ? `Test report: ${record.testUrl}` : null,
  ].filter(Boolean);

  const limitations =
    record.outcome === "passed"
      ? "This report covers only the behaviour exercised by the recorded Kane flow."
      : record.outcome === "failed"
        ? "This report records a genuine verification failure. It does not claim the checked behaviour is working."
        : "This run did not complete successfully. It is not a pass and must not be treated as a verified result.";

  return [
    "## Verification summary",
    record.summary || "No summary was recorded.",
    "",
    "## Outcome",
    `**${outcome}**`,
    "",
    "## Project and run",
    record.projectId ? `Project ID: ${record.projectId}` : "Project ID: not recorded",
    record.jobId ? `Job ID: ${record.jobId}` : null,
    `Verification ID: ${record.id}`,
    `Started: ${record.startedAt}`,
    record.finishedAt ? `Finished: ${record.finishedAt}` : null,
    "",
    "## Detected issues",
    issueSection(investigations),
    "",
    "## Technical findings",
    technical.length ? technical.map((line) => `- ${line}`).join("\n") : "- No additional technical details recorded.",
    "",
    "## Evidence boundary",
    limitations,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export async function ensureVerificationReport(record: VerificationRecord): Promise<Story | null> {
  if (record.outcome === "pending" || record.outcome === "running") return null;
  const owner = record.requestedBy?.trim();
  if (!owner) throw new Error("verification report cannot be created: owner is missing");

  const scope: RecordScope = { userId: owner, privileged: false, includeLegacy: false };
  const id = verificationReportId(record);
  const investigations = (await readInvestigations(scope).catch(() => [] as Investigation[])).filter((inv) =>
    (inv.verificationReferences || []).some((ref) => ref.verificationId === record.id || (record.jobId && ref.jobId === record.jobId)),
  );
  const existing = await getStoryById(id, scope).catch(() => undefined);
  const now = new Date().toISOString();
  const issues = investigations.length > 0 ? snapshotIssues(investigations) : existing?.verification?.issues ?? [];
  const base: Story = {
    id,
    slug: `verification-report-${record.id}`,
    title: `Verification report: ${outcomeLabel(record.outcome)}`,
    subtitle: record.summary || `Kane verification ${record.flow || "run"} on ${record.startedAt}.`,
    body: buildVerificationReportBody(record, investigations),
    status: "published",
    userId: owner,
    projectId: record.projectId ?? null,
    createdAt: existing?.createdAt || record.startedAt || now,
    updatedAt: now,
    publishedAt: record.finishedAt || existing?.publishedAt || now,
    generationSource: "template",
    reportKind: "verification",
    aiReport: existing?.aiReport ?? null,
    source: {
      repo: record.url,
      commits: [],
      changedFiles: [],
      observationSummary: record.summary || "No summary recorded.",
      observationSource: "none",
    },
    verification: {
      id: record.id,
      outcome: record.outcome,
      exitCode: record.exitCode,
      summary: record.summary,
      failingStep: record.failingStep,
      durationMs: record.durationMs,
      creditsConsumed: record.creditsConsumed,
      testUrl: record.testUrl,
      evidencePath: record.evidencePath,
      ndjsonPath: record.ndjsonPath,
      flow: record.flow,
      url: record.url,
      issues,
    },
    tags: ["verification", record.outcome],
  };

  return upsertStory(base, scope);
}