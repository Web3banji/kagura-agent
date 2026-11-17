import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";

export default function SettingsPage() {
  return (
    <div data-page="settings">
      <PageHeader
        title="Agent Settings"
        subtitle="Configuration foundations for integrations and publishing. Secrets are never exposed or stored in source."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="GitHub (OBSERVE)">
          <p className="text-sm text-muted">Repository connection for observing real development activity.</p>
          <div className="mt-3 text-xs text-muted space-y-1">
            <div>Status: <span className="text-warning">not configured</span></div>
            <div>Configure via secure server-side env/credentials (never committed). UI wiring pending.</div>
          </div>
        </Panel>
        <Panel title="Kane CLI (VERIFY)">
          <p className="text-sm text-muted">Local Kane CLI runner for real browser verification.</p>
          <div className="mt-3 text-xs text-muted space-y-1">
            <div>Status: <span className="text-fg">CLI authenticated (workspace config)</span></div>
            <div>Browser: Google Chrome with dedicated writable profile (absolute path, gitignored under <code className="text-fg">data/verification/kane-chrome-profile</code>).</div>
            <div>Compatibility: <span className="text-success">proven</span> by genuine Kane <code className="text-fg">run_end</code> pass (shell-nav, exit 0, run b0f88bc3-f486-4082-a3e8-d0543d134752).</div>
            <div>Execution adapter: implemented (CLI + server-side module, structured NDJSON parsing, absolute profile resolution).</div>
          </div>
        </Panel>
        <Panel title="AI Provider (WRITE)">
          <p className="text-sm text-muted">Provider/model configuration for evidence-grounded drafting.</p>
          <div className="mt-3 text-xs text-muted">Status: <span className="text-warning">not configured</span>. No keys stored.</div>
        </Panel>
        <Panel title="Publishing (REVIEW → PUBLISH)">
          <p className="text-sm text-muted">Approval and publication preferences for the public blog.</p>
          <div className="mt-3 text-xs text-muted">Status: <span className="text-warning">foundation only</span>. No publishing integrations active.</div>
        </Panel>
      </div>
      <Panel title="Security note" className="mt-4">
        <EmptyState
          title="No secrets displayed"
          detail="API keys, tokens, and private evidence paths must be managed server-side (e.g. environment variables) and are excluded from Git. This UI does not render secret values."
        />
      </Panel>
    </div>
  );
}