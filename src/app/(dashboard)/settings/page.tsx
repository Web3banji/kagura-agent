import { PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getObservationStatus } from "@/lib/github/observe";
import { aiConfigured } from "@/lib/ai/provider";
import { readVerificationRecords } from "@/lib/verification/store";
import { GitHubConfigForm } from "./github-config-form";
import { ObserveAction } from "./observe-action";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import Link from "next/link";

export const dynamic = "force-dynamic";
const execFileAsync = promisify(execFile);

async function kaneStatus() {
  try {
    const { stdout } = await execFileAsync("kane-cli", ["--version"], { cwd: process.cwd(), windowsHide: true, timeout: 8000 });
    const version = stdout.trim().split(/\r?\n/)[0] || "installed";
    let who = "unknown";
    try {
      const w = await execFileAsync("kane-cli", ["whoami"], { cwd: process.cwd(), windowsHide: true, timeout: 8000 });
      who = w.stdout.trim().split(/\r?\n/)[0] || who;
    } catch {}
    const profile = path.resolve(process.cwd(), "data", "verification", "kane-chrome-profile");
    let profileOk = false;
    try { await fs.access(profile); profileOk = true; } catch {}
    return { ok: true as const, version, who, profile, profileOk };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function SettingsPage() {
  const [obs, ai, kane, verifications] = await Promise.all([
    getObservationStatus(),
    Promise.resolve(aiConfigured()),
    kaneStatus(),
    readVerificationRecords(),
  ]);
  const latestVer = verifications[0];
  const appUrl = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || "http://localhost:3000";

  return (
    <div data-page="settings">
      <PageHeader
        title="Settings"
        subtitle="Connections and setup for KAGURA. Private details (like passwords or keys) are kept safe on the server and never shown here."
      />

      <Panel title="What these settings do" className="mb-6">
        <p className="text-sm text-muted leading-relaxed">KAGURA can work with a few connections: it can watch a GitHub project for updates, use an AI helper to write drafts, and run real tests on your app. You only need to change these if something isn’t connected or you want to point KAGURA at a different project.</p>
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

        <Panel title="Testing" description="Runs real checks on your app to see if things work.">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted">Test tool</span>
            <StatusBadge status={kane.ok ? "passed" : "failed"} />
          </div>
          <div className="text-sm space-y-1">
            {kane.ok ? (
              <>
                <p className="text-emerald-300">Ready on this computer.</p>
                <p className="text-xs text-muted">Signed in as: <span className="text-fg break-all">{kane.who}</span></p>
              </>
            ) : (
              <p className="text-rose-300">Not ready: {kane.error || "testing tool not available on this computer."}</p>
            )}
            <p className="text-xs text-muted">Latest test: {latestVer ? <><StatusBadge status={latestVer.outcome} /> <span className="ml-1">{new Date(latestVer.startedAt).toLocaleString()}</span></> : "none recorded yet"}</p>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
            <div className="mt-2 text-xs text-muted space-y-1 break-all">
              <p>App address for tests: <code>{appUrl}</code></p>
              {kane.ok ? <p>Tool version: {kane.version} · Browser profile: {kane.profile} ({kane.profileOk ? "present" : "missing"})</p> : null}
              <p>Tests run on the local computer (not on the website host) and record real results only.</p>
            </div>
          </details>
        </Panel>

        <Panel title="Publishing & safety" description="How stories are shared and how access is protected.">
          <div className="text-sm space-y-2">
            <p><span className="text-fg font-medium">Publishing:</span> drafts are only shared when you choose <strong>Approve &amp; publish</strong>. There is no automatic publishing.</p>
            <p><span className="text-fg font-medium">Public pages:</span> visitors can see the <Link href="/stories" className="text-accent underline">Published stories</Link> pages.</p>
            <p><span className="text-fg font-medium">Private/admin pages:</span> Home, history, tests, draft review, and settings are for managing KAGURA. On a live site these should be protected with an admin password/token.</p>
            <p><span className="text-fg font-medium">Your secrets:</span> keys and passwords are stored on the server and are not shown in this app.</p>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
            <div className="mt-2 text-xs text-muted space-y-1">
              <p>Admin protection uses <code>KAGURA_ADMIN_TOKEN</code> (or <code>ADMIN_PASSWORD</code>) when configured. Set <code>KAGURA_APP_URL</code> to your live site address for tests/links.</p>
            </div>
          </details>
        </Panel>
      </div>
    </div>
  );
}
