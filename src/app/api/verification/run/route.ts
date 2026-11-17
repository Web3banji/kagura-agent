import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { runKane } from "@/lib/kane/runner";
import { appendVerificationRecord, upsertVerificationRecord } from "@/lib/verification/store";
import type { VerificationRecord } from "@/types/verification";
import path from "path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FLOW_OBJECTIVE = 'Go to the provided URL. Verify the page shows "KAGURA" and "Home & status". Click the "Activity history" link in the sidebar navigation and verify the Activity history page is displayed. Click the "Checks & tests" link in the sidebar navigation and verify the Checks & tests page is displayed. Click the "Published stories" link in the sidebar navigation and verify the Stories page is displayed. Return to "Home & status" and verify it is displayed.';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { flow?: string; url?: string };
    const flow = body.flow || "shell-nav";
    const url = body.url || process.env.KAGURA_APP_URL || (process.env.KAGURA_APP_URL || process.env.KAGURA_APP_URL) || "http://localhost:3000";
    const profile = path.resolve(process.cwd(), "data", "verification", "kane-chrome-profile");
    const startedAt = new Date().toISOString();
    const tempId = randomUUID();

    const running: VerificationRecord = {
      id: tempId,
      flow,
      objective: FLOW_OBJECTIVE,
      url,
      chromeProfile: profile,
      outcome: "running",
      startedAt,
      source: "runner",
    };
    await appendVerificationRecord(running);

    const result = await runKane({
      objective: FLOW_OBJECTIVE,
      url,
      headless: true,
      timeoutSeconds: 180,
      name: `kagura-${flow}`,
      chromeProfile: profile,
    });

    const record: VerificationRecord = {
      id: result.id || tempId,
      flow,
      objective: FLOW_OBJECTIVE,
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
      source: "runner",
    };
    await upsertVerificationRecord(record);
    return NextResponse.json({ record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
