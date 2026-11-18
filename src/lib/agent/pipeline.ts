import { observeGitHub } from "@/lib/github/observe";
import { markCommitsProcessed, getUnprocessedCommits } from "@/lib/github/store";
import { type Analysis } from "./analyse";
import { verifyWithKane } from "./verify";
import { generateDraft } from "./write";
import { setPipelineState, getCurrentPipelineState } from "@/lib/pipeline";
import { appendJournalEvent } from "@/lib/journal/store";
import { upsertStory } from "@/lib/stories/store";
import { createRun, updateRun, getActiveRun } from "./runs";
import type { PipelineState } from "@/types/agent";
import type { AgentRun } from "@/types/run";
import type { Story } from "@/types/story";
import type { ObservedCommit } from "@/types/github";
import type { RecordScope } from "@/lib/auth/scope";
import { randomUUID } from "crypto";

export interface RunResult {
  run?: AgentRun;
  state: PipelineState;
  observationSummary?: string;
  analysisReason?: string;
  verificationId?: string;
  verificationOutcome?: string;
  draft?: Story;
  error?: string;
}

function commitsToText(commits: ObservedCommit[]): string {
  return commits.map((c) => c.message + " " + c.files.map((f) => f.filename).join(" ")).join(" ").toLowerCase();
}

function analyseCommits(commits: ObservedCommit[]): Analysis {
  const text = commitsToText(commits);
  let focus: Analysis["focus"] = "general";
  if (text.includes("stories") || text.includes("publish") || text.includes("editorial")) focus = "stories";
  else if (text.includes("command") || text.includes("dashboard") || text.includes("agent")) focus = "command-center";
  else if (text.includes("layout") || text.includes("sidebar") || text.includes("page") || text.includes("src/") || text.includes("component")) focus = "shell-nav";

  const deservesVerification = commits.length > 0;
  return {
    deservesVerification,
    reason: deservesVerification
      ? `Meaningful repository changes observed (${commits.length} commit(s), focus: ${focus}). Verification required before reporting.`
      : "No new commits to process.",
    focus,
    flow: "shell-nav",
        objective:
          'Go to the provided URL. Verify the page shows "KAGURA" and "Home & status". Click the "Activity history" link in the sidebar navigation and verify the Activity history page is displayed. Click the "Checks & tests" link in the sidebar navigation and verify the Checks & tests page is displayed. Click the "Published stories" link in the sidebar navigation and verify the Stories page is displayed. Return to "Home & status" and verify it is displayed.',
  };
}

export async function runPipeline(
  trigger: "manual" | "observe" = "manual",
  opts?: { userId?: string | null; scope?: RecordScope },
): Promise<RunResult> {
  const scope = opts?.scope;
  const active = await getActiveRun(scope);
  if (active) {
    const state = await getCurrentPipelineState();
    return { run: active, state, error: "An agent run is already in progress." };
  }

  const run = await createRun(trigger, { userId: opts?.userId ?? null });
  const started = new Date().toISOString();

  async function fail(stage: AgentRun["currentStage"], msg: string, extra?: Partial<AgentRun>): Promise<RunResult> {
    await updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), currentStage: stage, error: msg, ...extra, stageUpdate: { stage, status: "failed", error: msg } }, scope);
    await setPipelineState({ agentState: "failed", stage, note: msg, lastOutcome: "failed", lastError: msg, lastRunAt: started });
    const r = (await import("./runs")).readRuns(scope).then(rs => rs.find(x => x.id === run.id));
    return { run: await r, state: await getCurrentPipelineState(), error: msg };
  }

  try {
    // OBSERVE
    await updateRun(run.id, { currentStage: "OBSERVE", stageUpdate: { stage: "OBSERVE", status: "running", note: "Fetching real repository commits via GitHub API..." } }, scope);
    await setPipelineState({ agentState: "running", stage: "OBSERVE", note: "Observing repository activity...", lastRunAt: started, lastError: undefined });

    const observation = await observeGitHub();
    if (observation.error) {
      return fail("OBSERVE", `Observation failed: ${observation.error}`);
    }

    // Determine commits to process: prefer truly new; if none, pick unprocessed stored (prevents reprocessing duplicates)
    let targetCommits = observation.newCommits;
    if (targetCommits.length === 0) {
      targetCommits = await getUnprocessedCommits(5);
    }

    await appendJournalEvent({
      id: randomUUID(),
      type: "observation",
      source: observation.source,
      title: `Observed ${observation.repo}`,
      summary: `Fetched ${observation.commits.length} commit(s), ${observation.newCommits.length} new. ${observation.note || ""}`.trim(),
      timestamp: observation.observedAt,
      refs: observation.commits.slice(0, 5).map((c) => c.shortSha),
    });

    await updateRun(run.id, {
      currentStage: "OBSERVE",
      observation: { repo: observation.repo, source: observation.source, newCount: observation.newCommits.length, totalFetched: observation.commits.length },
      stageUpdate: { stage: "OBSERVE", status: "completed", note: `Observed ${observation.commits.length} commits (${observation.newCommits.length} new).` },
    }, scope);

    if (targetCommits.length === 0) {
      const note = "No new or unprocessed repository events to process. Observation complete.";
      await updateRun(run.id, {
        status: "completed", finishedAt: new Date().toISOString(), currentStage: "OBSERVE",
        stageUpdate: { stage: "ANALYSE", status: "skipped", note },
      }, scope);
      await setPipelineState({ agentState: "completed", stage: "OBSERVE", note, lastOutcome: "success", lastError: undefined, lastRunAt: started });
      return { run: (await (await import("./runs")).readRuns(scope)).find(r => r.id === run.id), state: await getCurrentPipelineState(), observationSummary: `${observation.repo}: ${observation.commits.length} commits fetched, 0 new.` };
    }

    // ANALYSE
    await updateRun(run.id, { currentStage: "ANALYSE", stageUpdate: { stage: "ANALYSE", status: "running", note: "Analysing commits and changed files..." } }, scope);
    await setPipelineState({ stage: "ANALYSE", note: "Analysing observed changes..." });
    const analysis = analyseCommits(targetCommits);

    await updateRun(run.id, { stageUpdate: { stage: "ANALYSE", status: "completed", note: analysis.reason } }, scope);

    // VERIFY
    let verificationRecord = null as Awaited<ReturnType<typeof verifyWithKane>> | null;
    if (analysis.deservesVerification) {
      await updateRun(run.id, { currentStage: "VERIFY", stageUpdate: { stage: "VERIFY", status: "running", note: `Running Kane verification (${analysis.flow})...` } }, scope);
      await setPipelineState({ stage: "VERIFY", note: `Running Kane verification (${analysis.flow}) against ${process.env.KAGURA_APP_URL || (process.env.KAGURA_APP_URL || process.env.KAGURA_APP_URL) || "http://localhost:3000"}...` });
      try {
        verificationRecord = await verifyWithKane(analysis);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateRun(run.id, { verificationOutcome: "error" }, scope);
        return fail("VERIFY", `Verification failed to execute: ${msg}`);
      }
      await appendJournalEvent({
        id: randomUUID(),
        type: "verification",
        source: "kane-cli",
        title: `Kane ${analysis.flow}: ${verificationRecord.outcome}`,
        summary: verificationRecord.summary || `Outcome ${verificationRecord.outcome}`,
        timestamp: verificationRecord.finishedAt || verificationRecord.startedAt,
        refs: [verificationRecord.testUrl, verificationRecord.ndjsonPath].filter(Boolean) as string[],
      });
      await updateRun(run.id, { verificationId: verificationRecord.id, verificationOutcome: verificationRecord.outcome }, scope);

      if (verificationRecord.outcome === "pending" || verificationRecord.outcome === "running") {
        const note = `Verification queued for the shared local runner and awaiting genuine results (job ${verificationRecord.jobId || verificationRecord.id}). No claim of pass/fail can be made until the runner syncs real Kane CLI output.`;
        await updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), error: note, stageUpdate: { stage: "VERIFY", status: "pending", note } }, scope);
        await setPipelineState({ agentState: "failed", stage: "VERIFY", note, lastOutcome: "blocked", lastError: note, lastVerificationId: verificationRecord.id, lastRunAt: started });
        return { run: (await (await import("./runs")).readRuns(scope)).find(r => r.id === run.id), state: await getCurrentPipelineState(), observationSummary: `${observation.repo}: ${targetCommits.length} commit(s) analysed`, analysisReason: analysis.reason, verificationId: verificationRecord.id, verificationOutcome: verificationRecord.outcome, error: note };
      }
      if (verificationRecord.outcome !== "passed") {
        const note = `Kane verification ${verificationRecord.outcome} (exit ${verificationRecord.exitCode ?? "n/a"}). ${verificationRecord.failingStep || verificationRecord.summary || "Inspect evidence and fix before claiming verified."}`;
        await updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), error: note, stageUpdate: { stage: "VERIFY", status: "failed", error: note } }, scope);
        await setPipelineState({ agentState: "failed", stage: "VERIFY", note, lastOutcome: verificationRecord.outcome === "did_not_start" ? "blocked" : "failed", lastError: note, lastVerificationId: verificationRecord.id, lastRunAt: started });
        return { run: (await (await import("./runs")).readRuns(scope)).find(r => r.id === run.id), state: await getCurrentPipelineState(), observationSummary: `${observation.repo}: ${targetCommits.length} commit(s) analysed`, analysisReason: analysis.reason, verificationId: verificationRecord.id, verificationOutcome: verificationRecord.outcome, error: note };
      }
      await updateRun(run.id, { stageUpdate: { stage: "VERIFY", status: "completed", note: verificationRecord.summary || "Verification passed." } }, scope);
    } else {
      await updateRun(run.id, { stageUpdate: { stage: "VERIFY", status: "skipped", note: "No verification required." } }, scope);
    }

    // WRITE
    await updateRun(run.id, { currentStage: "WRITE", stageUpdate: { stage: "WRITE", status: "running", note: "Generating factual draft from commits and verification evidence..." } }, scope);
    await setPipelineState({ stage: "WRITE", note: "Generating factual draft..." });

    const draft = await generateDraft(
      {
        repo: observation.repo,
        source: observation.source,
        commits: targetCommits.map((c) => ({ sha: c.sha, shortSha: c.shortSha, message: c.message, date: c.date, author: c.author, url: c.url })),
        changedFiles: Array.from(new Set(targetCommits.flatMap((c) => c.files.map((f) => f.filename)))).slice(0, 40),
        summary: `Observed ${targetCommits.length} commit(s) from ${observation.repo} (${observation.source}).`,
        observedAt: observation.observedAt,
        note: observation.note,
      },
      analysis,
      verificationRecord,
      { userId: opts?.userId ?? null },
    );
    await upsertStory(draft, scope);
    await markCommitsProcessed(targetCommits.map((c) => c.sha));
    await updateRun(run.id, { draftId: draft.id, stageUpdate: { stage: "WRITE", status: "completed", note: `Draft created: ${draft.title}` } }, scope);

    // REVIEW (awaiting approval)
    await updateRun(run.id, {
      status: "completed", finishedAt: new Date().toISOString(), currentStage: "REVIEW",
      stageUpdate: { stage: "REVIEW", status: "completed", note: "Draft ready for review/approval." },
    }, scope);
    // mark PUBLISH as pending (manual step)
    await updateRun(run.id, { stageUpdate: { stage: "PUBLISH", status: "pending", note: "Awaiting approval to publish." } }, scope);

    await setPipelineState({
      agentState: "completed",
      stage: "REVIEW",
      note: "Draft generated from real evidence and awaiting your review/approval.",
      lastOutcome: "success",
      lastVerificationId: verificationRecord?.id,
      lastDraftId: draft.id,
      lastError: undefined,
      lastRunAt: started,
    });

    return {
      run: (await (await import("./runs")).readRuns(scope)).find(r => r.id === run.id),
      state: await getCurrentPipelineState(),
      observationSummary: `${observation.repo}: ${observation.commits.length} fetched, ${observation.newCommits.length} new, ${targetCommits.length} processed.`,
      analysisReason: analysis.reason,
      verificationId: verificationRecord?.id,
      verificationOutcome: verificationRecord?.outcome,
      draft,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), error: msg }, scope);
    await setPipelineState({ agentState: "failed", note: `Pipeline error: ${msg}`, lastOutcome: "failed", lastError: msg, lastRunAt: started });
    return { run: (await (await import("./runs")).readRuns(scope)).find(r => r.id === run.id), state: await getCurrentPipelineState(), error: msg };
  }
}