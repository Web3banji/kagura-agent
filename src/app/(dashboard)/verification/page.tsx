import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readVerificationRecords, summarizeOutcome } from "@/lib/verification/store";
import { RerunVerificationButton } from "./rerun-button";
import { statusInfo } from "@/lib/ui-text";
import { resolveProjectId } from "@/lib/verification/context";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function VerificationLabPage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });

  // Resolve the user's projects to retrieve verification records for all of them.
  // Do not assume the currently configured global GitHub repository is the only project.
  let projectIds: string[] = [];
  if (scope.userId && hasDatabase()) {
    try {
      await ensureDb();
      const res = await getPool().query(
        "SELECT id FROM projects WHERE owner_user_id = $1 ORDER BY created_at DESC",
        [scope.userId],
      );
      projectIds = res.rows.map((r: { id: string }) => r.id).filter(Boolean);
    } catch {
      // Fall back to a single project ID from GitHub config.
    }
  }
  if (!projectIds.length) {
    const single = await resolveProjectId();
    if (single) projectIds.push(single);
  }

  // Fetch records for each project and merge, deduplicating by record id.
  const allRecords: Awaited<ReturnType<typeof readVerificationRecords>> = [];
  const seenIds = new Set<string>();
  for (const projectId of projectIds) {
    const records = await readVerificationRecords({
      projectId,
      includeLegacy: !!scope.includeLegacy,
      requestedBy: scope.privileged ? undefined : principal.userId,
    });
    for (const r of records) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        allRecords.push(r);
      }
    }
  }
  allRecords.sort(
    (a, b) =>
      new Date(b.startedAt || b.finishedAt || 0).getTime() -
      new Date(a.startedAt || a.finishedAt || 0).getTime(),
  );

  const summary = summarizeOutcome(allRecords);
  const latestInfo = statusInfo(summary.latest);

  return (
    <div data-page="verification">
      <PageHeader
        title="Checks & tests"
        subtitle="See if your app was tested, what passed, and where there were problems. Results shown here come from real test runs."
        actions={<RerunVerificationButton />}
      />

      <Panel title="What the results mean" className="mb-6">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs text-muted">
          <div className="flex gap-2"><StatusBadge status="passed" /><span><strong className="text-fg">Looks good</strong> — the test finished with no problems found.</span></div>
          <div className="flex gap-2"><StatusBadge status="failed" /><span><strong className="text-fg">Problem found</strong> — something didn’t work as expected during the test.</span></div>
          <div className="flex gap-2"><StatusBadge status="blocked" /><span><strong className="text-fg">Couldn’t run</strong> — the test couldn’t start or finish due to a setup/connection issue (not a pass).</span></div>
          <div className="flex gap-2"><StatusBadge status="running" /><span><strong className="text-fg">Working now</strong> — a test is currently in progress.</span></div>
          <div className="flex gap-2"><StatusBadge status="pending" /><span><strong className="text-fg">Waiting</strong> — waiting to start.</span></div>
          <div className="flex gap-2"><StatusBadge status="timeout" /><span><strong className="text-fg">Took too long</strong> — the test stopped because it ran out of time.</span></div>
        </div>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <Panel title="Latest result">
          <StatusBadge status={summary.latest} />
          <p className="mt-2 text-xs text-muted">{latestInfo.description}</p>
        </Panel>
        <Panel title="Passed"><div className="text-2xl font-semibold text-emerald-300">{summary.passed}</div><p className="text-xs text-muted mt-1">Tests that finished with no problems found.</p></Panel>
        <Panel title="Problems found"><div className="text-2xl font-semibold text-rose-300">{summary.failed}</div><p className="text-xs text-muted mt-1">Tests where something didn’t work as expected.</p></Panel>
        <Panel title="Couldn’t run"><div className="text-2xl font-semibold text-amber-300">{summary.blocked}</div><p className="text-xs text-muted mt-1">Tests blocked by setup or connection issues.</p></Panel>
      </div>

      <Panel title={`Test history (${allRecords.length})`} description="Newest results appear first. Open “Technical details” on a result if you need deeper information.">
        {allRecords.length === 0 ? (
          <EmptyState
            title="No tests have been run yet"
            detail="Click “Run a test now” to check that the main parts of your app work. You can also start a full check from the Home page, which may run a test when needed. Only real results will appear here."
          />
        ) : (
          <ul className="space-y-3">
            {allRecords.map((r) => {
              const info = statusInfo(r.outcome);
              return (
                <li key={r.id} className="rounded-lg border border-border bg-panel-2/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={r.outcome} />
                      <span className="text-sm font-medium text-fg">{r.flow === "shell-nav" ? "Main pages check" : r.flow}</span>
                      {r.projectId && (
                        <span className="text-[10px] text-muted/70 bg-muted/50 px-1.5 py-0.5 rounded">{r.projectId.slice(0, 8)}…</span>
                      )}
                    </div>
                    <div className="text-xs text-muted">
                      {new Date(r.startedAt).toLocaleString()}
                      {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted">{info.description}</p>
                  <div className="mt-2 text-sm text-fg/90">
                    {r.summary || "No summary available."}
                  </div>
                  {r.failingStep ? <div className="mt-2 text-sm text-rose-300"><strong>Where it went wrong:</strong> {r.failingStep}</div> : null}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
                    <div className="mt-2 grid gap-1 text-xs text-muted break-all">
                      {r.url ? <div>Page tested: <span className="font-mono">{r.url}</span></div> : null}
                      {typeof r.exitCode === "number" ? <div>Result code: <span className="font-mono">{r.exitCode}</span> (0 means success)</div> : null}
                      {typeof r.creditsConsumed === "number" ? <div>Test credits used: {r.creditsConsumed}</div> : null}
                      {r.command ? <div>Command run: <span className="font-mono">{r.command}</span></div> : null}
                      {r.testUrl ? <div>Full test report: <a className="text-accent underline" href={r.testUrl} target="_blank" rel="noreferrer">Open report</a></div> : null}
                      {r.evidencePath ? <div>Evidence file: <span className="font-mono">{r.evidencePath}</span></div> : null}
                      {r.sessionDir ? <div>Session folder: <span className="font-mono">{r.sessionDir}</span></div> : null}
                      {r.ndjsonPath ? <div>Run log: <span className="font-mono">{r.ndjsonPath}</span></div> : <div>Run log: <span className="font-mono">{`data/verification/runs/${r.id}.ndjson`}</span></div>}
                      {r.runEnd ? <div>Recorded outcome: <span className="font-mono">{String(r.runEnd.status || r.outcome)}</span></div> : null}
                      {r.jobId ? <div>Job ID: <span className="font-mono">{r.jobId}</span></div> : null}
                      {r.finishedAt ? <div>Finished: {new Date(r.finishedAt).toLocaleString()}</div> : null}
                    </div>
                    {r.stderr ? (
                      <div className="mt-2">
                        <div className="text-xs text-muted mb-1">Diagnostic messages:</div>
                        <pre className="text-xs whitespace-pre-wrap bg-black/20 rounded p-2 text-muted overflow-x-auto">{r.stderr}</pre>
                      </div>
                    ) : null}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
