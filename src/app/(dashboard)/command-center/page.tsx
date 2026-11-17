import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { getRecentLocalCommits } from "@/lib/journal/activity";
import { readVerificationRecords, summarizeOutcome } from "@/lib/verification/store";

export const dynamic = "force-dynamic";

export default async function CommandCenterPage() {
  const pipeline = getCurrentPipelineState();
  const commits = await getRecentLocalCommits(5);
  const verifications = await readVerificationRecords();
  const summary = summarizeOutcome(verifications);
  const latest = verifications[0];

  return (
    <div data-page="command-center">
      <PageHeader
        title="Command Center"
        subtitle="Operational view of the ECHOLOG agent. Only real repository and verification records are shown."
      />

      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <Panel title="Agent operational state">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted">State</div>
            <StatusBadge status={pipeline.agentState} />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-muted">Current pipeline stage</div>
            <span className="text-sm font-medium text-accent" data-testid="pipeline-stage">{pipeline.stage}</span>
          </div>
          <p className="mt-4 text-sm text-muted">{pipeline.note}</p>
        </Panel>

        <Panel title="Kane verification status">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted">Latest outcome</div>
            <StatusBadge status={summary.latest} />
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-muted text-xs">Passed</dt><dd className="font-medium">{summary.passed}</dd></div>
            <div><dt className="text-muted text-xs">Failed</dt><dd className="font-medium">{summary.failed}</dd></div>
            <div><dt className="text-muted text-xs">Blocked/No-start</dt><dd className="font-medium">{summary.blocked}</dd></div>
          </dl>
          {latest ? (
            <p className="mt-3 text-xs text-muted">Last run: {latest.flow} · {new Date(latest.startedAt).toLocaleString()}</p>
          ) : (
            <p className="mt-3 text-xs text-muted">No Kane verification has been recorded yet.</p>
          )}
        </Panel>

        <Panel title="Pipeline">
          <ol className="space-y-1.5 text-sm">
            {["OBSERVE", "ANALYSE", "VERIFY", "WRITE", "REVIEW", "PUBLISH"].map((s) => (
              <li key={s} className={s === pipeline.stage ? "text-accent font-medium" : "text-muted"}>
                {s}
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <Panel title="Recent real development activity">
        {commits.length === 0 ? (
          <EmptyState
            title="No development activity recorded"
            detail="No local commit history was found yet. Once real commits or GitHub events are observed, they will appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {commits.map((c) => (
              <li key={c.id} className="py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                <div>
                  <div className="text-sm font-medium text-fg">{c.title}</div>
                  <div className="text-xs text-muted">{c.source} · {c.summary}</div>
                </div>
                <div className="text-xs text-muted font-mono">{new Date(c.timestamp).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}