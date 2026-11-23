import type { VerificationRecord } from "@/types/verification";

export interface InvestigationOutputs {
  technicalExplanation: string;
  simpleExplanation: string;
  affectedAreas: string[] | null;
  expectedBehaviour: string | null;
  actualBehaviour: string | null;
  rootCause: string | null;
  severity: "low" | "medium" | "high" | "critical" | null;
}

/**
 * Generate the three investigation outputs from a Kane verification record.
 *
 * - Technical explanation: what failed, where, actual vs expected, evidence, affected areas, root cause (only if confirmed).
 * - Simple explanation: everyday language version.
 * - Affected areas, expected/actual behaviour, root cause, severity derived from evidence.
 *
 * Root cause is only set when the failing step or summary provides enough evidence
 * to identify it confidently. Otherwise it remains null.
 */
export function generateInvestigationOutputs(record: VerificationRecord): InvestigationOutputs {
  const flow = record.flow || "verification";
  const failingStep = record.failingStep || "";
  const summary = record.summary || "";
  const url = record.url || "";
  const exitCode = record.exitCode != null ? record.exitCode : "n/a";

  // Determine affected areas from available evidence.
  const affectedAreas: string[] = [];
  if (url) affectedAreas.push(url);
  if (failingStep) affectedAreas.push(failingStep);
  if (record.evidencePath) affectedAreas.push(record.evidencePath);

  // Root cause: only when evidence supports it.
  let rootCause: string | null = null;
  const combined = `${failingStep} ${summary}`.toLowerCase();
  if (combined.includes("click") || combined.includes("navigat")) {
    rootCause = "Navigation target or link may not be present or interactable at the time of the Kane check.";
  } else if (combined.includes("page shows") || combined.includes("displayed")) {
    rootCause = "Expected page content or element may not have rendered within the verification timeout.";
  } else if (combined.includes("exit code") && exitCode !== "n/a") {
    rootCause = `Kane verification exited with code ${exitCode}, indicating the checked behaviour did not pass.`;
  }

  // Severity based on outcome and available evidence.
  let severity: "low" | "medium" | "high" | "critical" | null = "medium";
  if (record.outcome === "failed" && record.exitCode != null && record.exitCode !== 0) {
    severity = "high";
  }
  if (!failingStep && !summary) {
    severity = "low";
  }

  const technicalExplanation = [
    `## What failed`,
    `The Kane CLI verification (flow: \`${flow}\`) did not pass. Outcome: **${record.outcome}** (exit code ${exitCode}).`,
    "",
    `## Where it failed`,
    url ? `- Target URL: ${url}` : "- Target URL: not recorded",
    failingStep ? `- Failing step: ${failingStep}` : "- Failing step: not identified",
    "",
    `## Actual versus expected behaviour`,
    `- Expected: verification completes successfully (exit 0, run_end status 'passed').`,
    `- Actual: ${summary || "No summary provided."} ${failingStep ? `The failure occurred at: ${failingStep}.` : ""}`,
    "",
    `## Relevant technical evidence`,
    evidenceLines(record).join("\n") || "- No detailed evidence available from the verification record.",
    "",
    `## Affected application areas`,
    affectedAreas.length ? affectedAreas.map((a) => `- ${a}`).join("\n") : "- No affected areas identified from evidence.",
    "",
    `## Root cause`,
    rootCause ? `- ${rootCause}` : "- Not confirmed by available evidence.",
    "",
    `## Technical implications`,
    "- The behaviour checked by this Kane flow is not verified as working.",
    "- Further investigation is required before claiming the issue is resolved.",
  ].join("\n");

  const simpleExplanation = [
    `KAGURA ran a check using Kane CLI on "${flow}" and it did not pass.`,
    "",
    `This means the part of the application being checked is not working as expected right now.`,
    failingStep
      ? `The check stopped at: ${failingStep}.`
      : "No specific failing step was identified.",
    url ? `The check was performed against: ${url}.` : "",
    "",
    "## What this means for you",
    "Something in the application needs attention before it can be considered verified.",
    "",
    "## Why it matters",
    "Until this is fixed, the behaviour covered by this check is not confirmed to work correctly.",
    "",
    "## Next step",
    "Review the technical explanation and evidence below, then use the AI fix prompt to guide a fix.",
  ].join("\n");

  return {
    technicalExplanation,
    simpleExplanation,
    affectedAreas: affectedAreas.length ? affectedAreas : null,
    expectedBehaviour: "Verification completes successfully (exit 0, run_end status 'passed').",
    actualBehaviour: summary || `Verification outcome: ${record.outcome}.`,
    rootCause,
    severity,
  };
}

function evidenceLines(record: VerificationRecord): string[] {
  const lines: string[] = [];
  if (record.flow) lines.push(`- Flow: ${record.flow}`);
  if (record.url) lines.push(`- Target URL: ${record.url}`);
  if (record.exitCode != null) lines.push(`- Exit code: ${record.exitCode}`);
  if (record.failingStep) lines.push(`- Failing step: ${record.failingStep}`);
  if (record.summary) lines.push(`- Summary: ${record.summary}`);
  if (record.durationMs != null) lines.push(`- Duration: ${(record.durationMs / 1000).toFixed(1)}s`);
  if (record.evidencePath) lines.push(`- Evidence path: ${record.evidencePath}`);
  if (record.ndjsonPath) lines.push(`- NDJSON run log: ${record.ndjsonPath}`);
  if (record.testUrl) lines.push(`- Test report: ${record.testUrl}`);
  if (record.stderr) lines.push(`- Stderr: ${record.stderr}`);
  return lines;
}
