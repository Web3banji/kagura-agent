import { PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getObservationStatus } from "@/lib/github/observe";
import { aiConfigured } from "@/lib/ai/provider";
import { readVerificationRecords } from "@/lib/verification/store";
import { countPendingJobs, getRunnerHeartbeat } from "@/lib/verification/jobs";
import { getRunnerToken } from "@/lib/auth/runner";
import { resolveProjectId } from "@/lib/verification/context";
import { GitHubConfigForm } from "./github-config-form";
import { ObserveAction } from "./observe-action";
import Link from "next/link";

export const dynamic = "force-dynamic";

function ageLabel(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function SettingsPage() {
  const projectId = await resolveProjectId();
  const [obs, ai, heartbeat, pendingJobs, verifications] = await Promise.all([
    getObservationStatus(),
    Promise.resolve(aiConfigured()),
    getRunnerHeartbeat(),
    countPendingJobs(projectId),
    readVerificationRecords({ projectId, includeLegacy: true }),
  ]);
  const latestVer = verifications[0];
  const lastSuccessful = verifications.find((r) => r.outcome === "passed");
  const appUrl = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || "http://localhost:3000";
  const runnerConfigured = !!getRunnerToken();
  const runnerConnected = runnerConfigured && heartbeat.status === "connected";

  return (
    <div data-page="settings">
      <PageHeader
        title="Settings"
        subtitle="Connections and setup for KAGURA. Private details (like passwords or keys) are kept safe on the server and never shown here."
      />

      <Panel title="What these settings do" className="mb-6">
        <p className="text-sm text-muted leading-relaxed">KAGURA can work with a few connections: it can watch a GitHub project for updates, use an AI helper to write drafts, and run real tests on your app via a shared local runner. You only need to change these if something isn’t connected or you want to point KAGURA at a different project.</p>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Project updates (GitHub)" description="Where KAGURA looks for new changes in your project.">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted">GitHub connection</span>
            <StatusBadge status={obs.tokenConfigured ? "passed" : "blocked"} />
          </div>
          <div className="text-sm space-y-1">
            <p className={obs.tokenConfigured ? "text-emerald-300" : "text-warning"}>
              {obs.tokenConfigured ? "Connected — can read updates from GitHub." : "Not fully connected — checking locally when possible."}
            </p>
            <p className="text-xs text-muted">Watching: <span className="text-fg font-medium break-all">{obs.repo}</span></p>
            <p className="text-xs text-muted">Updates saved: {obs.eventsCount} · Last checked: {obs.state.lastObservedAt ? new Date(obs.state.lastObservedAt).toLocaleString() : "never"}</p>
            {obs.state.lastStatus === "failed" && obs.state.lastError ? <p className="text-xs text-rose-300">Last issue: {obs.state.lastError}</p> : null}
          </div>
          <GitHubConfigForm initialOwner={obs.config.owner} initialRepo={obs.config.repo} configuredIn={obs.config.configuredIn} />
          <ObserveAction />
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Setup help (for admins)</summary>
            <div className="mt-2 text-xs text-muted space-y-1">
              <p>To connect GitHub, add <code>GITHUB_TOKEN</code> in your server settings (never in shared/public files). This lets KAGURA read project updates.</p>
              <p>Repository can be set with <code>GITHUB_REPO_OWNER</code> / <code>GITHUB_REPO_NAME</code> or <code>GITHUB_REPO</code>.</p>
            </div>
          </details>
        </Panel>

        <Panel title="Draft writing help (AI)" description="Optional help for writing story drafts.">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted">AI writing</span>
            <StatusBadge status={ai.configured ? "passed" : "none"} />
          </div>
          <div className="text-sm space-y-1">
            <p className={ai.configured ? "text-emerald-300" : "text-fg"}>{ai.configured ? `Connected (${ai.provider || "AI provider"})` : "Not connected — drafts will use a clear built-in template."}</p>
            <p className="text-xs text-muted">Either way, drafts are based on real project updates and test results only (never invented).</p>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Setup help (for admins)</summary>
            <div className="mt-2 text-xs text-muted space-y-1">
              <p>Add a server-side key: <code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>. Optionally set <code>AI_PROVIDER</code> and <code>AI_MODEL</code>. Keys are never shown.</p>
            </div>
          </details>
        </Panel>

        <Panel title="Testing runner" description="Real Kane CLI checks run on the shared authenticated local runner (not on the Vercel server) and sync genuine results back to KAGURA.">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted">Runner connectivity</span>
            <StatusBadge status={runnerConnected ? "passed" : "blocked"} />
          </div>
          <div className="text-sm space-y-1">
            <p className={runnerConnected ? "text-emerald-300" : "text-warning"}>
              {runnerConnected ? "Connected — runner heartbeat is recent." : runnerConfigured ? "Disconnected — no recent runner heartbeat." : "Not configured — set KAGURA_RUNNER_TOKEN and start the local runner."}
            </p>
            <dl className="grid grid-cols-2 gap-2 text-xs mt-2">
              <div><dt className="text-muted">Runner token</dt><dd className="font-medium text-fg">{runnerConfigured ? "Configured" : "Not set"}</dd></div>
              <div><dt className="text-muted">Last heartbeat</dt><dd className="font-medium text-fg">{heartbeat.lastHeartbeat ? `${new Date(heartbeat.lastHeartbeat).toLocaleString()} (${ageLabel(heartbeat.lastHeartbeat)})` : "Never"}</dd></div>
              <div><dt className="text-muted">Runner version</dt><dd className="font-medium text-fg break-all">{heartbeat.version || "Unknown"}</dd></div>
              <div><dt className="text-muted">Pending jobs</dt><dd className="font-medium text-fg">{pendingJobs}</dd></div>
              <div><dt className="text-muted">Last successful run</dt><dd className="font-medium text-fg">{heartbeat.lastSuccessfulExecution ? new Date(heartbeat.lastSuccessfulExecution).toLocaleString() : lastSuccessful?.finishedAt ? new Date(lastSuccessful.finishedAt).toLocaleString() : "None recorded"}</dd></div>
              <div><dt className="text-muted">Latest test record</dt><dd className="font-medium text-fg">{latestVer ? <><StatusBadge status={latestVer.outcome} /> <span className="ml-1">{new Date(latestVer.startedAt).toLocaleString()}</span></> : "None"}</dd></div>
            </dl>
            {heartbeat.note ? <p className="text-xs text-muted mt-1">{heartbeat.note}</p> : null}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
            <div className="mt-2 text-xs text-muted space-y-1 break-all">
              <p>App address for tests: <code>{appUrl}</code></p>
              <p>Project scope: <code>{projectId}</code></p>
              {heartbeat.runnerId ? <p>Runner ID: <code>{heartbeat.runnerId}</code></p> : null}
              {heartbeat.currentJobId ? <p>Current job: <code>{heartbeat.currentJobId}</code></p> : null}
              <p>Status is based on actual runner heartbeats, not token presence. Kane CLI is never executed on the hosted server.</p>
            </div>
          </details>
        </Panel>

        <Panel title="Publishing & safety" description="How stories are shared and how access is protected.">
          <div className="text-sm space-y-2">
            <p><span className="text-fg font-medium">Publishing:</span> drafts are only shared when you choose <strong>Approve &amp; publish</strong>. There is no automatic publishing.</p>
            <p><span className="text-fg font-medium">Public pages:</span> visitors can see the <Link href="/stories" className="text-accent underline">Published stories</Link> pages.</p>
            <p><span className="text-fg font-medium">Private/admin pages:</span> Home, history, tests, draft review, and settings are for managing KAGURA. On a live site these should be protected with an admin password/token.</p>
            <p><span className="text-fg font-medium">Your secrets:</span> keys, tokens, and passwords are stored on the server and are not shown in this app.</p>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
            <div className="mt-2 text-xs text-muted space-y-1">
              <p>Admin protection uses <code>KAGURA_ADMIN_TOKEN</code> (or <code>ADMIN_PASSWORD</code>) when configured. Runner access uses a separate <code>KAGURA_RUNNER_TOKEN</code>. Set <code>KAGURA_APP_URL</code> to your live site address for tests/links.</p>
            </div>
          </details>
        </Panel>
      </div>
    </div>
  );
}
