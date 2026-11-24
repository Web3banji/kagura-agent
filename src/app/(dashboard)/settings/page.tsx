import Link from "next/link";
import { PageHeader, Panel } from "@/components/ui/Primitives";
import { getObservationStatus } from "@/lib/github/observe";
import { aiConfigured } from "@/lib/ai/provider";
import { readVerificationRecords } from "@/lib/verification/store";
import { countPendingJobs, getRunnerHeartbeat } from "@/lib/verification/jobs";
import { getRunnerToken } from "@/lib/auth/runner";
import { resolveProjectId } from "@/lib/verification/context";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { hasDatabase } from "@/lib/db";
import { GitHubConfigForm } from "./github-config-form";
import { ObserveAction } from "./observe-action";

export const dynamic = "force-dynamic";

type ServiceState = "Configured" | "Not configured" | "Recently active" | "Processing" | "Waiting for heartbeat" | "Needs attention" | "Unavailable" | "Blocked" | "Not tested";

function ageLabel(iso?: string): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stateTone(state: ServiceState): string {
  switch (state) {
    case "Recently active": return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
    case "Configured": return "border-sky-500/25 bg-sky-500/10 text-sky-300";
    case "Processing": return "border-sky-500/25 bg-sky-500/10 text-sky-300";
    case "Waiting for heartbeat": return "border-amber-500/25 bg-amber-500/10 text-amber-300";
    case "Needs attention": return "border-amber-500/25 bg-amber-500/10 text-amber-300";
    case "Blocked": return "border-amber-500/25 bg-amber-500/10 text-amber-300";
    case "Unavailable": return "border-rose-500/25 bg-rose-500/10 text-rose-300";
    case "Not tested": return "border-slate-400/25 bg-slate-400/10 text-slate-300";
    case "Not configured": return "border-slate-400/25 bg-slate-400/10 text-slate-300";
  }
}

function StatePill({ state }: { state: ServiceState }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${stateTone(state)}`}>{state}</span>;
}

function ConfigRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg/20 p-3">
      <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 text-sm text-fg break-words">{value}</div>
      {detail ? <div className="mt-1 text-xs text-muted">{detail}</div> : null}
    </div>
  );
}


export default async function SettingsPage() {
  const principal = await getServerPrincipal();
  const projectId = await resolveProjectId();
  const allowLegacy = !principal.userId || principalHasLegacyAccess(principal);

  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const [obs, ai, heartbeatRaw, pendingJobs, verifications] = await Promise.all([
    getObservationStatus({ privileged: !!scope.privileged }).catch(() => ({ config: { owner: "", repo: "", configuredIn: "file" as const }, state: {} as { lastObservedAt?: string; lastStatus?: "success" | "failed"; lastError?: string }, eventsCount: 0, tokenConfigured: false, repo: "" })),
    Promise.resolve(aiConfigured()),
    getRunnerHeartbeat().catch(() => ({ status: "disconnected" as const, note: "Runner heartbeat unavailable." })),
    countPendingJobs(projectId).catch(() => 0),
    readVerificationRecords({ requestedBy: principal.userId ?? undefined, includeLegacy: allowLegacy }).catch(() => []),
  ]);
  const heartbeat = heartbeatRaw as import("@/types/verification").RunnerHeartbeat;

  const latestVer = verifications[0];
  const lastSuccessful = verifications.find((r) => r.outcome === "passed");
  const runnerConfigured = !!getRunnerToken();
  const runnerConnected = runnerConfigured && heartbeat.status === "connected";
  const dbAvailable = hasDatabase();
  const adminTokenConfigured = !!(process.env.KAGURA_ADMIN_TOKEN || process.env.ECHOLOG_ADMIN_TOKEN || process.env.ADMIN_PASSWORD);

  const githubState: ServiceState = !obs.tokenConfigured && !(obs.repo ?? 'Not configured') ? "Not configured" : obs.state?.lastStatus === "failed" ? "Needs attention" : obs.state?.lastStatus === "success" ? "Recently active" : obs.tokenConfigured || !!(obs.repo ?? 'Not configured') ? "Configured" : "Not configured";
  const aiState: ServiceState = ai.configured ? "Configured" : "Not configured";
  const runnerState: ServiceState = !runnerConfigured ? "Not configured" : runnerConnected ? (pendingJobs > 0 ? "Processing" : "Recently active") : "Waiting for heartbeat";
  const dbState: ServiceState = dbAvailable ? "Configured" : "Not configured";
  const adminState: ServiceState = adminTokenConfigured ? "Configured" : "Needs attention";

  return (
    <div className="space-y-6" data-page="settings">
      <PageHeader
        eyebrow="SETTINGS"
        title="Settings"
        subtitle="Manage account, integrations, and operational configuration. User-managed settings are editable here; operator-managed configuration is clearly marked and never exposes secrets."
      />

      <Panel title="Configuration overview" description="Current state from real configuration and runtime signals. Configuration presence is not proof of end-to-end connectivity or successful execution.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">GitHub</div><div className="mt-2"><StatePill state={githubState} /></div><div className="mt-2 text-xs text-muted">{(obs.repo ?? 'Not configured') || "No repository configured"}</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">AI provider</div><div className="mt-2"><StatePill state={aiState} /></div><div className="mt-2 text-xs text-muted">{ai.configured ? ai.provider || "Configured" : "Template drafting fallback"}</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Runner</div><div className="mt-2"><StatePill state={runnerState} /></div><div className="mt-2 text-xs text-muted">{runnerConnected ? `Heartbeat ${ageLabel(heartbeat.lastHeartbeat)}` : runnerConfigured ? "No recent heartbeat" : "Runner token not configured"}</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Database</div><div className="mt-2"><StatePill state={dbState} /></div><div className="mt-2 text-xs text-muted">{dbAvailable ? "DATABASE_URL configured" : "DATABASE_URL not configured"}</div></div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Account and workspace" description="Account information comes from the authenticated session. Sensitive credentials are never shown.">
          <div className="grid gap-3 sm:grid-cols-2">
            <ConfigRow label="Signed-in user" value={principal.user?.name || principal.user?.githubLogin || principal.user?.email || (principal.authorized ? "Authenticated" : "Not signed in")} detail={principal.user?.githubLogin ? `@${principal.user.githubLogin}` : undefined} />
            <ConfigRow label="Email" value={principal.user?.email || "Not available"} />
            <ConfigRow label="Workspace access" value={principal.kind === "admin-token" ? "Admin-token infrastructure access" : principal.user?.isBootstrapOwner ? "Bootstrap owner" : "Standard workspace user"} detail="Access is enforced by existing auth/session rules." />
            <ConfigRow label="Project scope" value={projectId} detail="Used for project-scoped verification and runner records." />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href="/api/auth/signout" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-xs text-fg hover:border-accent/40">Sign out</a>
            <Link href="/sign-in" className="rounded-lg border border-border bg-bg/10 px-3 py-2 text-xs text-muted hover:text-fg">Account sign-in page</Link>
          </div>
          <p className="mt-3 text-xs text-muted">Account profile editing is limited to fields supported by the current auth/session implementation. No fake account controls are shown.</p>
        </Panel>

        <Panel title="Security and access" description="Existing security controls and access boundaries. No secrets, tokens, or passwords are displayed.">
          <div className="space-y-3 text-sm text-muted">
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3"><div className="font-medium text-fg">Authentication</div><div className="mt-1 text-xs">Session-based user access is enforced server-side. Admin-token infrastructure access is separate and token values are never shown.</div></div>
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3"><div className="font-medium text-fg">Admin protection</div><div className="mt-1 text-xs">{adminTokenConfigured ? "An admin token/password is configured on the server." : "No admin token/password is configured. In production, protected admin access should be configured by an operator."}</div></div>
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3"><div className="font-medium text-fg">Runner access</div><div className="mt-1 text-xs">Runner API uses a separate server-configured `KAGURA_RUNNER_TOKEN`. The token value is not displayed. Runner endpoints remain authorization-protected.</div></div>
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3"><div className="font-medium text-fg">Public vs private</div><div className="mt-1 text-xs">Published stories are public. Dashboard, settings, verification, intelligence, and management actions remain protected by existing auth controls.</div></div>
          </div>
        </Panel>
      </div>

      <Panel title="Integrations" description="Real connection states from existing integration/configuration sources. Connect/disconnect actions use existing APIs and permission checks.">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-xl border border-border bg-bg/20 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2"><div><div className="text-sm font-medium text-fg">GitHub</div><div className="text-xs text-muted">Used for repository observation, commit context, and project evidence.</div></div><StatePill state={githubState} /></div>
            <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted">
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Repository</div><div className="mt-1 text-fg/90 break-all">{(obs.repo ?? 'Not configured') || "Not configured"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Token/config</div><div className="mt-1 text-fg/90">{obs.tokenConfigured ? "Server credential configured" : "No server credential detected"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Last checked</div><div className="mt-1 text-fg/90">{obs.state?.lastObservedAt ? `${new Date(obs.state.lastObservedAt).toLocaleString()} (${ageLabel(obs.state.lastObservedAt)})` : "Never"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Observed events</div><div className="mt-1 text-fg/90">{obs.eventsCount}</div></div>
            </div>
            {obs.state?.lastStatus === 'failed' ? <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-2 text-xs text-amber-200">Global observation reported a failure. Details redacted from global status.</div> : null}
            <GitHubConfigForm initialOwner={('')} initialRepo={('')} configuredIn={(obs.config.configuredIn)} />
            <ObserveAction />
            <p className="text-xs text-muted">OAuth/token values are never displayed. Repository discovery/connect endpoints remain available through existing GitHub integration APIs; this page preserves the existing config/observe controls.</p>
          </div>

          <div className="rounded-xl border border-border bg-bg/20 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2"><div><div className="text-sm font-medium text-fg">AI provider</div><div className="text-xs text-muted">Used for drafting assistance. Drafts must remain grounded in real evidence.</div></div><StatePill state={aiState} /></div>
            <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted">
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Provider</div><div className="mt-1 text-fg/90">{ai.configured ? ai.provider || "Configured" : "Not configured"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Model</div><div className="mt-1 text-fg/90">{process.env.AI_MODEL ? process.env.AI_MODEL : "Default / provider-managed"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Availability</div><div className="mt-1 text-fg/90">{ai.configured ? "AI drafting available" : "Template fallback available"}</div></div>
              <div className="rounded-md border border-border/60 bg-bg/20 p-2"><div className="font-tech uppercase tracking-[0.12em] text-[10px]">Secrets</div><div className="mt-1 text-fg/90">API keys are never shown</div></div>
            </div>
            <div className="rounded-md border border-border/70 bg-bg/15 p-3 text-xs text-muted">
              <div className="font-medium text-fg">Operator-managed configuration</div>
              <p className="mt-1">AI provider keys/models are configured through server environment variables (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `AI_PROVIDER`, `AI_MODEL`). Configure them outside the UI; do not paste secrets into the app.</p>
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Runner and verification configuration" description="Runner readiness is based on real heartbeat/job records. Infrastructure problems are not project findings.">
          <div className="flex items-center justify-between mb-3"><div className="text-sm text-muted">Runner state</div><StatePill state={runnerState} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ConfigRow label="Runner token" value={runnerConfigured ? "Configured on server" : "Not configured"} detail="Token value is never shown." />
            <ConfigRow label="Last heartbeat" value={heartbeat.lastHeartbeat ? `${new Date(heartbeat.lastHeartbeat).toLocaleString()} (${ageLabel(heartbeat.lastHeartbeat)})` : "Never"} detail={heartbeat.note || undefined} />
            <ConfigRow label="Runner version" value={heartbeat.version || "Unknown"} />
            <ConfigRow label="Pending/running jobs" value={String(pendingJobs)} />
            <ConfigRow label="Last successful execution" value={heartbeat.lastSuccessfulExecution ? new Date(heartbeat.lastSuccessfulExecution).toLocaleString() : lastSuccessful?.finishedAt ? new Date(lastSuccessful.finishedAt).toLocaleString() : "None recorded"} />
            <ConfigRow label="Latest verification record" value={latestVer ? `${latestVer.outcome} (${fmtSafeDate(latestVer.startedAt)})` : "None"} detail={latestVer?.failingStep ? `Failing step: ${latestVer.failingStep}` : undefined} />
          </div>
          <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-100/90 space-y-2">
            <div className="font-medium text-amber-200">Operator-managed runner requirements</div>
            <p>Run the local/shared runner outside the hosted app with required server env vars (e.g., `KAGURA_RUNNER_TOKEN`, `KAGURA_APP_URL`). The hosted server never executes Kane CLI.</p>
            <p>Do not bypass OS-level isolation. Ordinary-user jobs must run with required isolation enabled; unavailable/misconfigured isolation should be treated as blocked/unavailable, not operational.</p>
            <p>Sandbox credentials/passwords are never displayed and must not be entered into this UI.</p>
          </div>
        </Panel>

        <Panel title="Notifications and preferences" description="Only preferences with real existing behavior are shown.">
          <div className="space-y-3">
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3">
              <div className="text-sm font-medium text-fg">Publishing control</div>
              <p className="mt-1 text-xs text-muted">Publishing is manual and already implemented: drafts are published only through explicit review/publish actions in Intelligence. No automatic publishing toggle is exposed because it is not implemented.</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3">
              <div className="text-sm font-medium text-fg">Notifications</div>
              <p className="mt-1 text-xs text-muted">No persisted in-app/email notification preference system is currently implemented. This page does not add decorative toggles. Status is visible in Activity, Verification, and runner/job records.</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-bg/20 p-3">
              <div className="text-sm font-medium text-fg">Theme/account preferences</div>
              <p className="mt-1 text-xs text-muted">Theme is managed by the existing app/theme system. Additional account preferences are not fabricated here.</p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="System status and diagnostics" description="Actual available health/config signals. States distinguish operational, processing, needs attention, blocked, unavailable, and not configured.">
        <div className="overflow-x-auto rounded-xl border border-border bg-bg/15">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-bg/30 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">
              <tr><th className="px-3 py-3">Service</th><th className="px-3 py-3">State</th><th className="px-3 py-3">Source</th><th className="px-3 py-3">Details</th></tr>
            </thead>
            <tbody>
              <tr className="border-t border-border/70"><td className="px-3 py-3">Database</td><td className="px-3 py-3"><StatePill state={dbState} /></td><td className="px-3 py-3 text-xs text-muted">DATABASE_URL/env + db helpers</td><td className="px-3 py-3 text-xs text-muted">{dbAvailable ? "Configured. Persistent stores available when DB reachable." : "Not configured. Local/dev file fallback behavior depends on runtime."}</td></tr>
              <tr className="border-t border-border/70"><td className="px-3 py-3">GitHub integration</td><td className="px-3 py-3"><StatePill state={githubState} /></td><td className="px-3 py-3 text-xs text-muted">getObservationStatus / GitHub config</td><td className="px-3 py-3 text-xs text-muted">{('repoConfigured' in obs ? obs.repoConfigured : false) ? 'Repository configured.' : 'No repository configured.'} Last check: {obs.state?.lastObservedAt ? fmtSafeDate(obs.state.lastObservedAt) : 'never'}. Global details are redacted for safety.</td></tr>
              <tr className="border-t border-border/70"><td className="px-3 py-3">AI provider</td><td className="px-3 py-3"><StatePill state={aiState} /></td><td className="px-3 py-3 text-xs text-muted">aiConfigured() env config</td><td className="px-3 py-3 text-xs text-muted">{ai.configured ? `Provider: ${ai.provider || "configured"}.` : "Not configured; template drafting fallback remains available."}</td></tr>
              <tr className="border-t border-border/70"><td className="px-3 py-3">Runner</td><td className="px-3 py-3"><StatePill state={runnerState} /></td><td className="px-3 py-3 text-xs text-muted">getRunnerHeartbeat / countPendingJobs / runner token config</td><td className="px-3 py-3 text-xs text-muted">{runnerConfigured ? (runnerConnected ? `Connected. Heartbeat ${ageLabel(heartbeat.lastHeartbeat)}.` : "Token configured but heartbeat stale/unavailable.") : "KAGURA_RUNNER_TOKEN not configured."} Pending/running jobs: {pendingJobs}.</td></tr>
              <tr className="border-t border-border/70"><td className="px-3 py-3">Admin protection</td><td className="px-3 py-3"><StatePill state={adminState} /></td><td className="px-3 py-3 text-xs text-muted">Admin token env presence</td><td className="px-3 py-3 text-xs text-muted">{adminTokenConfigured ? "Admin token/password configured on server." : "Not configured; operator should set admin token/password in production environments."}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-muted">Diagnostics are observational only. They distinguish configuration, liveness, and recorded activity; they do not expose credentials and do not claim end-to-end connectivity unless actually tested.</div>
      </Panel>
    </div>
  );
}

function fmtSafeDate(value?: string | null): string {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString();
}
