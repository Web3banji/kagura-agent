import type { VerificationRecord } from "@/types/verification";
import type { InvestigationCategory, Investigation, InvestigationVerificationReference } from "@/types/investigation";
import { generateInvestigationOutputs } from "./explainer";

export { generateInvestigationOutputs };

/**
 * Outcomes that represent genuine application defects that warrant investigation.
 * Infrastructure / runner / execution problems are deliberately excluded.
 */
const ACTIONABLE_OUTCOMES = new Set(["failed"]);

/**
 * Determine whether a completed Kane verification result represents an actionable
 * application issue that should produce or update an investigation.
 *
 * Rules:
 * - "failed" with a real failingStep/summary can indicate an application defect.
 * - "blocked", "did_not_start", "timeout" are infrastructure/execution problems,
 *   not application bugs, and must NOT create investigations.
 * - "passed" does not create investigations; it may resolve an existing one if
 *   the evidence confirms the specific issue is fixed.
 * - "pending"/"running" are not terminal and produce no investigation.
 */
export function isActionableVerification(record: VerificationRecord): boolean {
  if (!ACTIONABLE_OUTCOMES.has(record.outcome as never)) return false;
  // Require actual evidence of a failure, not just an outcome label.
  if (!record.failingStep && !record.summary && !record.stderr) return false;
  return true;
}

export function isResolutionEvidence(record: VerificationRecord): boolean {
  return record.outcome === "passed" && record.exitCode === 0 && Boolean(record.runEnd);
}

/**
 * Extract a concise title from a verification record for use as an investigation title.
 */
function deriveTitle(record: VerificationRecord): string {
  const flow = record.flow || "verification";
  if (record.failingStep) {
    return `${flow}: ${record.failingStep}`;
  }
  if (record.summary) {
    return `${flow}: ${record.summary.slice(0, 80)}${record.summary.length > 80 ? "…" : ""}`;
  }
  return `${flow}: application issue detected`;
}

/**
 * Derive a category from available evidence. Defaults to "other" when no
 * specific category can be confidently assigned.
 */
function deriveCategory(record: VerificationRecord): InvestigationCategory {
  const step = (record.failingStep || "").toLowerCase();
  const summary = (record.summary || "").toLowerCase();
  const combined = `${step} ${summary}`;

  if (combined.includes("click") || combined.includes("navigat") || combined.includes("link") || combined.includes("button")) {
    return "navigation-failure" as InvestigationCategory;
  }
  if (combined.includes("assert") || combined.includes("expect") || combined.includes("page shows") || combined.includes("displayed")) {
    return "ui-non-determinism" as InvestigationCategory;
  }
  if (combined.includes("kane") || combined.includes("verification") || combined.includes("run_end") || combined.includes("exit code")) {
    return "verification-failure" as InvestigationCategory;
  }
  return "other" as InvestigationCategory;
}

/**
 * Convert a VerificationRecord into an InvestigationVerificationReference.
 */
export function verificationToReference(record: VerificationRecord): InvestigationVerificationReference {
  return {
    verificationId: record.id,
    jobId: record.jobId,
    outcome: record.outcome,
    detectedAt: record.finishedAt || record.startedAt,
    evidencePath: record.evidencePath,
    failingStep: record.failingStep,
    summary: record.summary,
  };
}

/**
 * Process a completed Kane verification record against existing investigations.
 *
 * Matching rules (tightened to avoid merging unrelated issues):
 * - A new actionable failure matches an existing open investigation only when
 *   the failing step is identical AND the project/owner match.
 * - Summary or URL alone are never sufficient to merge investigations.
 * - A passing run resolves an investigation only when its evidence
 *   corresponds to that specific issue (same failing step or same verification ID).
 *
 * One verification can produce zero, one, or multiple investigations.
 * This implementation creates at most one investigation per verification call,
 * because a single Kane run_end result describes one flow outcome. If future
 * Kane output structures enumerate multiple distinct failures, this function
 * can be extended to create one investigation per distinct failure.
 *
 * Returns the investigation(s) that were created, updated, or resolved,
 * or null if no investigation was affected.
 */
export async function processVerificationResult(
  record: VerificationRecord,
  opts?: { ownerUserId?: string; projectId?: string | null; repositoryConnectionId?: string | null },
): Promise<{ investigations: Investigation[]; action: "created" | "updated" | "resolved" | "none" }> {
  // Import store dynamically to avoid circular dependency issues at module load.
  const { readInvestigations, createInvestigation, updateInvestigation, appendVerificationReference } = await import("./store");

  const investigations = await readInvestigations();

  // --- Resolution path: passed verification can resolve an open investigation ---
  if (isResolutionEvidence(record)) {
    const matching = investigations.find((inv) => {
      if (inv.status !== "open") return false;
      if (opts?.projectId && inv.projectId !== opts.projectId) return false;
      if (opts?.ownerUserId && inv.ownerUserId !== opts.ownerUserId) return false;
      // Resolve only when evidence corresponds to this specific issue:
      // same failing step, or this exact verification ID is already referenced.
      return inv.verificationReferences.some(
        (ref) =>
          (record.failingStep && ref.failingStep === record.failingStep) ||
          ref.verificationId === record.id,
      );
    });

    if (matching) {
      const updated = await updateInvestigation(
        matching.id,
        {
          status: "resolved",
          rootCause: matching.rootCause || "Resolved by subsequent Kane verification with exit 0 (genuine run_end).",
        },
        { userId: opts?.ownerUserId, includeLegacy: true, privileged: false } as never,
      );
      if (updated) {
        return { investigations: [updated], action: "resolved" };
      }
    }
    return { investigations: [], action: "none" };
  }

  // --- Non-actionable outcomes: do not create investigations ---
  if (!isActionableVerification(record)) {
    return { investigations: [], action: "none" };
  }

  // --- Actionable: find or create investigation ---
  const reference = verificationToReference(record);
  const matching = investigations.find((inv) => {
    if (inv.status === "resolved" || inv.status === "superseded") return false;
    if (opts?.projectId && inv.projectId !== opts.projectId) return false;
    if (opts?.ownerUserId && inv.ownerUserId !== opts.ownerUserId) return false;
    // Require identical failing step for matching. Summary or URL alone
    // are insufficient to merge distinct defects.
    return inv.verificationReferences.some(
      (ref) => ref.failingStep === record.failingStep && ref.failingStep != null,
    );
  });

  if (matching) {
    // Update existing investigation with new verification reference.
    const updated = await appendVerificationReference(matching.id, reference, {
      userId: opts?.ownerUserId,
      includeLegacy: true,
      privileged: false,
    } as never);
    if (updated) {
      // Refresh the fix prompt when new evidence changes the recommended action.
      const regenerated = await updateInvestigation(
        matching.id,
        {
          aiFixPrompt: generateAIFixPrompt(updated, record),
        },
        { userId: opts?.ownerUserId, includeLegacy: true, privileged: false },
      );
      return { investigations: [regenerated || updated], action: "updated" };
    }
    return { investigations: [], action: "none" };
  }

  // --- Create new investigation ---
  const { technicalExplanation, simpleExplanation, affectedAreas, expectedBehaviour, actualBehaviour, rootCause, severity } =
    generateInvestigationOutputs(record);

  const created = await createInvestigation(
    {
      ownerUserId: opts?.ownerUserId ?? "",
      projectId: opts?.projectId ?? null,
      repositoryConnectionId: opts?.repositoryConnectionId ?? null,
      title: deriveTitle(record),
      category: deriveCategory(record),
      technicalExplanation,
      simpleExplanation,
      rootCause,
      affectedAreas,
      expectedBehaviour,
      actualBehaviour,
      severity,
      status: "open",
      verificationReferences: [reference],
      evidenceReferences: record.evidencePath ? [record.evidencePath] : [],
      aiFixPrompt: generateAIFixPrompt(null as unknown as Investigation, record),
    },
  );

  return { investigations: [created], action: "created" };
}

/**
 * Generate an AI coding-agent fix prompt tailored to the specific verification failure.
 * Uses a template fallback when no AI provider is configured.
 */
function generateAIFixPrompt(_investigation: Investigation | null, record: VerificationRecord): string {
  const evidenceLines: string[] = [];
  if (record.flow) evidenceLines.push(`- Flow: ${record.flow}`);
  if (record.url) evidenceLines.push(`- Target URL: ${record.url}`);
  if (record.exitCode != null) evidenceLines.push(`- Exit code: ${record.exitCode}`);
  if (record.failingStep) evidenceLines.push(`- Failing step: ${record.failingStep}`);
  if (record.summary) evidenceLines.push(`- Summary: ${record.summary}`);
  if (record.durationMs != null) evidenceLines.push(`- Duration: ${(record.durationMs / 1000).toFixed(1)}s`);
  if (record.evidencePath) evidenceLines.push(`- Evidence path: ${record.evidencePath}`);
  if (record.ndjsonPath) evidenceLines.push(`- NDJSON log: ${record.ndjsonPath}`);
  if (record.testUrl) evidenceLines.push(`- Test report: ${record.testUrl}`);
  if (record.stderr) evidenceLines.push(`- Stderr: ${record.stderr}`);

  return [
    "# KAGURA Investigator — AI Fix Prompt",
    "",
    "## Issue Summary",
    `A Kane CLI verification (flow: ${record.flow || "unknown"}) reported a failure that may indicate an application defect.`,
    "",
    "## Technical Findings",
    evidenceLines.join("\n") || "- No detailed evidence available from the verification record.",
    "",
    "## Affected Files or Components",
    "- Not yet identified. Investigate the failing step and related application code before assuming a root cause.",
    "",
    "## Expected Behaviour",
    "The Kane verification should complete successfully (exit 0, run_end status 'passed').",
    "",
    "## Actual Behaviour",
    `Outcome: ${record.outcome}. ${record.failingStep ? `Failing step: ${record.failingStep}` : ""} ${
      record.summary ? `Summary: ${record.summary}` : ""
    }`,
    "",
    "## Required Corrective Action",
    "1. Reproduce the failure locally using the same Kane flow and objective.",
    "2. Identify the specific application code, route, component, or function responsible.",
    "3. Implement the minimal fix to resolve the observed behaviour.",
    "4. Re-run the Kane verification to confirm the issue is resolved.",
    "",
    "## Constraints",
    "- Preserve existing functionality; do not introduce breaking changes.",
    "- Do not modify verification infrastructure or Kane CLI configuration unless clearly required.",
    "- Do not fabricate root causes; investigate before assuming.",
    "",
    "## Reporting",
    "After making changes, explain what was changed and identify any remaining uncertainty.",
    "Then trigger a new Kane verification to confirm resolution.",
  ].join("\n");
}
