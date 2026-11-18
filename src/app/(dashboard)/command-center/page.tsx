import { EmptyState, PageHeader, Panel, WorkflowStrip } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { readVerificationRecords, summarizeOutcome } from "@/lib/verification/store";
import { readStories } from "@/lib/stories/store";
import { readRuns } from "@/lib/agent/runs";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getObservationStatus } from "@/lib/github/observe";
import { readObservedEvents } from "@/lib/github/store";
import { RunPipelineButton } from "./run-button";
import { ObserveButton } from "./observe-button";
import { resolveProjectId } from "@/lib/verification/context";
import { stageDetail, stageLabel, statusInfo } from "@/lib/ui-text";
import Link from "next/link";

export const dynamic = "force-dynamic";

function stageStatusColor(status: string) {
  if (status === "completed") return "text-emerald-300";
  if (status === "running") return "text-accent";
  if (status === "failed") return "text-rose-300";
  if (status === "skipped") return "text-muted";
  return "text-muted";
}

export default async function CommandCenterPage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const projectId = await resolveProjectId();
  const pipeline = await getCurrentPipelineState();
  const [verifications, stories, runs, obsStatus, observedEvents] = await Promise.all([
    readVerificationRecords({
      projectId,
      includeLegacy: !!scope.includeLegacy,
      requestedBy: scope.privileged ? undefined : principal.userId,
    }),
    readStories(scope),
    readRuns(scope),
    getObservationStatus(),
    readObservedEvents(),
  ]);
  const summary = summarizeOutcome(verifications);
  const latest = verifications[0];
  const drafts = stories.filter((s) => s.status === "review" || s.status === "draft");
  const published = stories.filter((s) => s.status === "published");
  const latestRun = runs[0];
  const recentActivity = observedEvents.slice(0, 5);
  const agentInfo = statusInfo(pipeline.agentState);
  const hasEverRun = runs.length > 0 || observedEvents.length > 0 || verifications.length > 0;

  return (
    <div data-page="command-center">
      <PageHeader
        title="Home & status"
        subtitle="See what KAGURA is doing right now, check if your project was tested, and start a new check."
        actions={
          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start w-full md:w-auto">
            <ObserveButton />
            <RunPipelineButton />
          </div>
        }
      />

      {!hasEverRun ? (
        <Panel className="mb-6 border-accent/30 bg-accent-soft/20">
          <h2 className="text-base font-semibold text-fg">Welcome to KAGURA</h2>
          <p className="mt-2 text-sm text-muted max-w-3xl leading-relaxed">
            KAGURA helps you keep track of what’s changing in your project and turn real updates into clear stories you can share.
            It follows a simple process: <strong>check for changes</strong>, <strong>understand them</strong>, <strong>test that things work</strong>,
            <strong> write a draft</strong>, then <strong>you review and publish</strong>. Nothing is made up — drafts and results are based on real activity and real test outcomes.
          </p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-3 text-sm text-muted">
            <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">1. Start here</span><div className="mt-1 text-xs">Click <strong>Start a new check</strong> to look for updates, test your app, and create a draft.</div></li>
            <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">2. Review the draft</span><div className="mt-1 text-xs">Open <Link href="/editorial" className="text-accent underline">Review drafts</Link> to edit it and choose <strong>Approve &amp; publish</strong>.</div></li>
            <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">3. Share your story</span><div className="mt-1 text-xs">Published stories appear on the <Link href="/stories" className="text-accent underline">Published stories</Link> page.</div></li>
          </ol>
        </Panel>
      ) : null}

      <Panel title="How KAGURA works" description="The highlighted step shows where things are right now." className="mb-6">
        <WorkflowStrip current={pipeline.stage} />
        <p className="mt-3 text-xs text-muted">Current step: <span className="text-fg font-medium">{stageLabel(pipeline.stage)}</span> — {stageDetail(pipeline.stage)}</p>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 mb-6">
        <Panel title="What’s happening now" description="The current status of KAGURA.">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-muted">Status</div>
            <StatusBadge status={pipeline.agentState} />
          </div>
          <p className="mt-2 text-xs text-muted">{agentInfo.description}</p>
          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="text-sm text-muted">Current step</div>
            <span className="text-sm font-medium text-accent" data-testid="pipeline-stage">{stageLabel(pipeline.stage)}</span>
          </div>
          <p className="mt-3 text-sm text-fg/90">{pipeline.note}</p>
          {pipeline.lastRunAt ? <p className="mt-2 text-xs text-muted">Last check: {new Date(pipeline.lastRunAt).toLocaleString()}</p> : <p className="mt-2 text-xs text-muted">No checks run yet.</p>}
          {pipeline.lastError ? <p className="mt-2 text-xs text-rose-300">Something needs attention: {pipeline.lastError}</p> : null}
        </Panel>

        <Panel title="Project updates" description="Recent changes found in your project.">
          <div className="text-sm text-muted">Watching</div>
          <div className="text-sm font-medium text-fg mt-1 break-all">{obsStatus.repo}</div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted">Connection</dt><dd className="font-medium">{obsStatus.tokenConfigured ? "Connected to GitHub" : "Checking locally"}</dd></div>
            <div><dt className="text-muted">Updates saved</dt><dd className="font-medium">{obsStatus.eventsCount}</dd></div>
            <div><dt className="text-muted">Last check</dt><dd className="font-medium">{obsStatus.state.lastStatus ? (obsStatus.state.lastStatus === "success" ? "Worked" : "Had a problem") : "Never"}</dd></div>
            <div><dt className="text-muted">New last time</dt><dd className="font-medium">{obsStatus.state.lastNewCount ?? "-"}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-muted">
            {obsStatus.state.lastObservedAt ? `Last looked: ${new Date(obsStatus.state.lastObservedAt).toLocaleString()}` : "Hasn’t checked for changes yet."}
          </p>
          {!obsStatus.tokenConfigured ? <p className="mt-2 text-xs text-warning">Tip: connect a GitHub access token in Settings to read updates directly from GitHub.</p> : null}
          {obsStatus.state.lastError ? <p className="mt-2 text-xs text-rose-300">Issue: {obsStatus.state.lastError}</p> : null}
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer text-accent">Technical details</summary>
            <div className="mt-1 space-y-1 break-all">Source: {obsStatus.tokenConfigured ? "GitHub API" : "Local git"} · Config: {obsStatus.config.configuredIn}</div>
          </details>
        </Panel>

        <Panel title="Testing status" description="Has your project been tested?">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-muted">Latest result</div>
            <StatusBadge status={summary.latest} />
          </div>
          <p className="mt-2 text-xs text-muted">{statusInfo(summary.latest).description}</p>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-muted text-xs">Passed</dt><dd className="font-medium text-emerald-300">{summary.passed}</dd></div>
            <div><dt className="text-muted text-xs">Problems</dt><dd className="font-medium text-rose-300">{summary.failed}</dd></div>
            <div><dt className="text-muted text-xs">Couldn’t run</dt><dd className="font-medium text-amber-300">{summary.blocked}</dd></div>
          </dl>
          {latest ? (
            <div className="mt-3 text-xs text-muted space-y-1">
              <p>Last test: {new Date(latest.startedAt).toLocaleString()}</p>
              {latest.summary ? <p className="text-fg/80 line-clamp-2">{latest.summary}</p> : null}
              <Link href="/verification" className="text-accent underline inline-block mt-1">See test details</Link>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted">No tests recorded yet. A test runs during “Start a new check” when needed.</p>
          )}
        </Panel>

        <Panel title="Stories" description="Drafts to review and stories already shared.">
          <dl className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div><dt className="text-muted text-xs">Ready to review</dt><dd className="font-medium text-lg">{drafts.length}</dd></div>
            <div><dt className="text-muted text-xs">Published</dt><dd className="font-medium text-lg">{published.length}</dd></div>
          </dl>
          {drafts.length > 0 ? (
            <Link href="/editorial" className="inline-flex text-sm font-medium text-accent underline">Review drafts now →</Link>
          ) : published.length > 0 ? (
            <Link href="/stories" className="inline-flex text-sm text-accent underline">View published stories →</Link>
          ) : (
            <p className="text-xs text-muted">When a check creates a draft, you’ll review and publish it here.</p>
          )}
          {drafts[0] ? <p className="mt-3 text-xs text-muted line-clamp-2">Latest draft: <span className="text-fg/90">{drafts[0].title}</span></p> : null}
        </Panel>
      </div>

      {latestRun ? (
        <Panel title="What happened in the last check" description="Each step shows what was done. You can open details if you’re curious." className="mb-6">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted mb-3">
            <span>Started: {new Date(latestRun.startedAt).toLocaleString()}</span>
            {latestRun.finishedAt ? <span>Finished: {new Date(latestRun.finishedAt).toLocaleString()}</span> : null}
            {latestRun.observation ? <span>Project: {latestRun.observation.repo}</span> : null}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
            {latestRun.stages.map((st) => {
              const info = statusInfo(st.status);
              return (
                <div key={st.stage} className="rounded border border-border bg-panel-2/40 p-2.5" title={stageDetail(st.stage)}>
                  <div className={`text-xs font-medium ${stageStatusColor(st.status)}`}>{stageLabel(st.stage)}</div>
                  <div className="mt-1"><StatusBadge status={st.status} /></div>
                  <div className="text-[11px] text-muted mt-1 leading-snug">{info.description}</div>
                  {st.note ? <div className="text-[11px] text-muted mt-1 line-clamp-3" title={st.note}>{st.note}</div> : null}
                  {st.error ? <div className="text-[11px] text-rose-300 mt-1 line-clamp-3">{st.error}</div> : null}
                </div>
              );
            })}
          </div>
          {latestRun.error ? <p className="mt-3 text-sm text-rose-300">Issue: {latestRun.error}</p> : null}
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer text-accent">Technical details</summary>
            <div className="mt-1 space-y-1">Run ID: <span className="font-mono">{latestRun.id}</span> · Trigger: {latestRun.trigger} · Status: {latestRun.status}</div>
          </details>
        </Panel>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Recent project updates" description="A quick look at the latest changes found.">
          {recentActivity.length === 0 ? (
            <EmptyState
              title="No changes found yet"
              detail="Click “Check for changes” to look for recent updates in your project. If you connect GitHub in Settings, KAGURA can read updates directly from there."
              action={<Link href="/settings" className="text-sm text-accent underline">Open Settings</Link>}
            />
          ) : (
            <ul className="divide-y divide-border">
              {recentActivity.map((c) => (
                <li key={c.sha} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium text-fg">{c.message}</div>
                    <span className="text-xs text-muted shrink-0">{c.processed ? "Reviewed" : "New"}</span>
                  </div>
                  <div className="text-xs text-muted mt-1">{c.author} · {new Date(c.date).toLocaleString()}</div>
                  {c.files?.length ? <div className="text-xs text-muted mt-1">{c.files.length} file{c.files.length === 1 ? "" : "s"} changed</div> : null}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-accent">Details</summary>
                    <div className="text-xs text-muted mt-1 font-mono break-all">{c.shortSha}</div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {recentActivity.length > 0 ? <div className="mt-3"><Link href="/journal" className="text-sm text-accent underline">View full activity history →</Link></div> : null}
        </Panel>

        <Panel title="Recent checks" description="A history of checks that have run.">
          {runs.length === 0 ? (
            <EmptyState
              title="No checks yet"
              detail="Click “Start a new check” to look for changes, test your app, and create a draft you can review."
            />
          ) : (
            <ul className="divide-y divide-border">
              {runs.slice(0, 8).map((r) => (
                <li key={r.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">{new Date(r.startedAt).toLocaleString()}</div>
                    <div className="text-xs text-muted mt-0.5">Step: {stageLabel(r.currentStage)}{r.observation ? ` · ${r.observation.newCount} new update${r.observation.newCount === 1 ? "" : "s"}` : ""}</div>
                    {r.draftId ? <div className="text-xs text-emerald-300 mt-0.5">Draft created — ready to review</div> : null}
                    {r.error ? <div className="text-xs text-rose-300 mt-0.5 line-clamp-2">{r.error}</div> : null}
                  </div>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
