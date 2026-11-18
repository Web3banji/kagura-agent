import Link from "next/link";
import { PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getObservationStatus } from "@/lib/github/observe";
import { getServerPrincipal } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

const INTEGRATIONS = [
  {
    name: "GitHub",
    description: "Read project updates (commits, pull requests, issues) from a connected repository.",
    key: "github",
  },
  {
    name: "GitLab",
    description: "Connect a GitLab project.",
    key: "gitlab",
    available: false,
  },
  {
    name: "Jira",
    description: "Import issues and sprint activity.",
    key: "jira",
    available: false,
  },
  {
    name: "Linear",
    description: "Track cycles and project tasks.",
    key: "linear",
    available: false,
  },
];

export default async function IntegrationsPage() {
  await getServerPrincipal();
  const obs = await getObservationStatus();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        subtitle="Connect KAGURA to your project tools. Only real, authenticated connections are shown."
      />

      <Panel title="GitHub" description="Source of project updates for checks and stories.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
          <div>
            <div className="text-sm font-medium text-fg">Connection</div>
            <div className="text-xs text-muted mt-0.5">
              Watching <span className="font-medium break-all">{obs.repo || "not configured"}</span>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <StatusBadge status={obs.tokenConfigured ? "passed" : "blocked"} />
          </div>
          <div>
            <Link href="/settings" className="text-sm text-accent underline">
              Configure GitHub →
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted mt-3">
          {obs.tokenConfigured
            ? "KAGURA can read updates from this GitHub repository using the configured token."
            : "Not connected — add GITHUB_TOKEN and GITHUB_REPO_OWNER/GITHUB_REPO_NAME in your server settings."}
        </p>
        {obs.state.lastError ? (
          <p className="text-xs text-rose-300 mt-1">Last issue: {obs.state.lastError}</p>
        ) : null}
      </Panel>

      <Panel title="Other integrations" description="Additional integrations are planned but not yet implemented.">
        <ul className="divide-y divide-border">
          {INTEGRATIONS.filter((i) => i.key !== "github").map((i) => (
            <li key={i.key} className="py-3 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{i.name}</div>
                <div className="text-xs text-muted mt-0.5">{i.description}</div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded border border-muted/30 bg-muted/5 text-muted font-tech">
                Not available
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

