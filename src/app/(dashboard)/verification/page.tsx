import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readVerificationRecords } from "@/lib/verification/store";

export const dynamic = "force-dynamic";

const outcomes = ["pending", "running", "passed", "failed", "blocked", "did_not_start", "timeout"] as const;

export default async function VerificationLabPage() {
  const records = await readVerificationRecords();

  return (
    <div data-page="verification">
      <PageHeader
        title="Verification Lab"
        subtitle="Foundation for actual Kane CLI verification runs. Records shown here come from real adapter executions; no fabricated results."
      />

      <div className="grid gap-4 lg:grid-cols-3 mb-6">
        <Panel title="Run states" className="lg:col-span-1">
          <div className="flex flex-wrap gap-2">
            {outcomes.map((o) => (
              <StatusBadge key={o} status={o} />
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            <strong>blocked/did_not_start</strong> means verification could not execute as a valid test (e.g. auth, browser, URL, config) — not a pass.
          </p>
        </Panel>
        <Panel title="Execution adapter (foundation)" className="lg:col-span-2">
          <ul className="text-sm text-muted space-y-2">
            <li>• Adapter: <code className="text-fg">scripts/kane-verify.mjs</code> (CLI) and <code className="text-fg">src/lib/kane/runner.ts</code> (server-side module).</li>
            <li>• Invokes <code className="text-fg">kane-cli run</code> with <code className="text-fg">--agent</code>, tags <code className="text-fg">KANE_CLI_USER_AGENT=kilocode</code>, requires real <code className="text-fg">--url</code>.</li>
            <li>• Captures stdout NDJSON + stderr, parses final <code className="text-fg">run_end</code>, maps exit codes (0 pass, 1 fail, 2 did not start, 3 timeout).</li>
            <li>• Stores NDJSON artifacts and structured records under <code className="text-fg">data/verification/</code> (gitignored) for inspection and UI display.</li>
            <li>• On failure: returns actionable diagnosis/next step; fix and rerun required.</li>
          </ul>
          <div className="mt-3 rounded border border-border bg-panel-2/40 p-3 text-xs font-mono text-muted overflow-x-auto">
            node scripts/kane-verify.mjs --url &lt;real-running-url&gt; --flow shell-nav --headless --timeout 180
          </div>
        </Panel>
      </div>

      <Panel title="Verification records">
        {records.length === 0 ? (
          <EmptyState
            title="No verification runs recorded"
            detail="No Kane CLI execution has been recorded yet. Run the adapter against the real local application URL to create a genuine record. Pending/running states are shown only for real executions in progress."
          />
        ) : (
          <ul className="space-y-3">
            {records.map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-panel-2/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.outcome} />
                    <span className="text-sm font-medium">{r.flow}</span>
                    {typeof r.exitCode === "number" ? (
                      <span className="text-xs text-muted font-mono">exit {r.exitCode}</span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted font-mono">
                    {new Date(r.startedAt).toLocaleString()}
                    {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}
                  </div>
                </div>
                <div className="mt-2 text-sm text-muted">
                  {r.summary || "No summary available."}
                  {r.failingStep ? <div className="mt-1 text-rose-300">Failing step: {r.failingStep}</div> : null}
                </div>
                <div className="mt-2 grid gap-1 text-xs text-muted">
                  {r.url ? <div>URL: <span className="font-mono">{r.url}</span></div> : null}
                  {typeof r.creditsConsumed === "number" ? <div>Credits consumed: {r.creditsConsumed}</div> : null}
                  {r.evidencePath ? <div className="break-all">Evidence: <span className="font-mono">{r.evidencePath}</span></div> : null}
                  {r.testUrl ? <div className="break-all">Test Manager: <a className="text-accent underline" href={r.testUrl} target="_blank" rel="noreferrer">{r.testUrl}</a></div> : null}
                  {r.sessionDir ? <div className="break-all">Session dir: <span className="font-mono">{r.sessionDir}</span></div> : null}
                  <div className="break-all">NDJSON: <span className="font-mono">{`data/verification/runs/${r.id}.ndjson`}</span></div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}