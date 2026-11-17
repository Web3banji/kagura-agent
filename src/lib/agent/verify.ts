import { runKane } from "@/lib/kane/runner";
import { appendVerificationRecord } from "@/lib/verification/store";
import type { VerificationRecord } from "@/types/verification";
import type { Analysis } from "./analyse";
import path from "path";

export async function verifyWithKane(
  analysis: Analysis,
  opts?: { source?: "local" | "runner"; jobId?: string },
): Promise<VerificationRecord> {
  const url = process.env.KAGURA_APP_URL || (process.env.KAGURA_APP_URL || process.env.KAGURA_APP_URL) || "http://localhost:3000";
  const profile = path.resolve(process.cwd(), "data", "verification", "kane-chrome-profile");
  const startedAt = new Date().toISOString();
  const result = await runKane({
    objective: analysis.objective,
    url,
    headless: true,
    timeoutSeconds: 180,
    name: `kagura-${analysis.flow}`,
    chromeProfile: profile,
  });

  const record: VerificationRecord = {
    id: result.id || crypto.randomUUID(),
    flow: analysis.flow,
    objective: analysis.objective,
    command: result.command,
    url,
    chromeProfile: profile,
    outcome: result.outcome,
    exitCode: result.exitCode ?? undefined,
    summary: result.summary,
    failingStep: result.failingStep,
    durationMs: result.durationMs,
    creditsConsumed: result.creditsConsumed,
    evidencePath: result.evidencePath,
    testUrl: result.testUrl,
    sessionDir: result.sessionDir,
    ndjsonPath: result.ndjsonPath,
    runEnd: result.runEnd,
    stderr: result.stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: opts?.source || "local",
    jobId: opts?.jobId,
  };
  await appendVerificationRecord(record);
  return record;
}