import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readJournalEvents } from "@/lib/journal/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { readObservedEvents, readProjectObservedEvents } from "@/lib/github/store";
import { readInvestigations } from "@/lib/investigations/store";
import { readStories } from "@/lib/stories/store";
import { readRuns } from "@/lib/agent/runs";
import { getObservationStatus } from "@/lib/github/observe";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import type { VerificationRecord } from "@/types/verification";
import type { Investigation } from "@/types/investigation";
import type { Story } from "@/types/story";
import type { AgentRun } from "@/types/run";
import type { ObservedCommit, ProjectObservedCommit } from "@/types/github";
import type { JournalEvent } from "@/types/journal";

export const dynamic = "force-dynamic";

type ActivityKind = "verification" | "investigation" | "monitoring" | "publishing" | "run" | "note";
type ActivityStatus = "completed" | "processing" | "waiting" | "blocked" | "failed" | "incomplete" | "attention";

type AttributionKind = "project" | "workspace" | "global" | "unknown";

type ActivityItem = {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  statusLabel: string;
  title: string;
  summary: string;
  timestamp: string;
  projectName?: string;
  projectId?: string;
  attribution: AttributionKind;
  attributionLabel: string;
  href?: string;
  hrefLabel?: string;
  details: Array<{ label: string; value: string }>;
  raw?: string;
};

type FilterKey = "all" | "verification" | "investigation" | "monitoring" | "publishing";

function fmtDate(value?: string | null): string {
  if (!value) return "Unknown time";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString();
}

function dayKey(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function statusTone(status: ActivityStatus): string {
  switch (status) {
    case "completed": return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
    case "processing": return "border-sky-500/25 bg-sky-500/10 text-sky-300";
    case "waiting": return "border-slate-400/25 bg-slate-400/10 text-slate-300";
    case "blocked": return "border-amber-500/25 bg-amber-500/10 text-amber-300";
    case "failed": return "border-rose-500/25 bg-rose-500/10 text-rose-300";
    case "incomplete": return "border-amber-500/25 bg-amber-500/10 text-amber-300";
    case "attention": return "border-orange-500/25 bg-orange-500/10 text-orange-300";
  }
}

function kindLabel(kind: ActivityKind): string {
  switch (kind) {
    case "verification": return "Verification";
    case "investigation": return "Issue / Investigation";
    case "monitoring": return "Monitoring / Repository";
    case "publishing": return "Publishing / Intelligence";
    case "run": return "Check run";
    case "note": return "Note";
  }
}

type ProjectLookup = { nameById: Map<string, string>; repoConnectionToProjectId: Map<string, string>; visibleProjects: Array<{ id: string; name: string; repositoryConnectionId: string | null }> };

async function resolveProjectLookup(ownerUserId: string | undefined): Promise<ProjectLookup> {
  const lookup: ProjectLookup = { nameById: new Map(), repoConnectionToProjectId: new Map(), visibleProjects: [] };
  if (!hasDatabase() || !ownerUserId) return lookup;
  try {
    await ensureDb();
    const res = await getPool().query(
      `SELECT p.id, p.name, prl.repository_connection_id
       FROM projects p
       LEFT JOIN project_repository_links prl ON prl.project_id = p.id AND prl.owner_user_id = p.owner_user_id AND prl.link_status = 'active'
       WHERE p.owner_user_id = $1`,
      [ownerUserId],
    );
    for (const row of res.rows as Array<{ id: string; name: string; repository_connection_id: string | null }>) {
      const id = String(row.id);
      lookup.nameById.set(id, String(row.name || id));
      if (row.repository_connection_id) lookup.repoConnectionToProjectId.set(String(row.repository_connection_id), id);
      if (!lookup.visibleProjects.some((p) => p.id === id)) lookup.visibleProjects.push({ id, name: String(row.name || id), repositoryConnectionId: row.repository_connection_id ? String(row.repository_connection_id) : null });
    }
  } catch {}
  return lookup;
}

function verificationStatus(outcome: string): { status: ActivityStatus; label: string } {
  if (outcome === "passed") return { status: "completed", label: "Completed successfully" };
  if (outcome === "failed") return { status: "failed", label: "Failed" };
  if (outcome === "blocked" || outcome === "did_not_start") return { status: "blocked", label: "Blocked" };
  if (outcome === "timeout") return { status: "incomplete", label: "Incomplete" };
  if (outcome === "pending") return { status: "waiting", label: "Waiting" };
  if (outcome === "running") return { status: "processing", label: "Currently processing" };
  return { status: "attention", label: "Needs attention" };
}

function attributionForProject(projectId: string | undefined, projectNames: Map<string, string>): { attribution: AttributionKind; attributionLabel: string; projectName?: string } {
  if (!projectId) return { attribution: "unknown", attributionLabel: "Historical / unknown attribution" };
  return { attribution: "project", attributionLabel: "Project-specific", projectName: projectNames.get(projectId) || projectId };
}

function mapVerification(r: VerificationRecord, projectNames: Map<string, string>): ActivityItem {
  const vs = verificationStatus(r.outcome);
  const attr = attributionForProject(r.projectId, projectNames);
  const summary = r.outcome === "passed"
    ? "A real check finished successfully for what it tested."
    : r.outcome === "failed"
      ? (r.summary || "A real check finished and reported a problem.")
      : r.outcome === "blocked" || r.outcome === "did_not_start"
        ? "The check could not start or finish because of setup or execution problems. This is not a project pass or fail."
        : r.outcome === "timeout"
          ? "The check ran out of time before finishing. This is incomplete, not a pass or fail."
          : r.outcome === "running" || r.outcome === "pending"
            ? "This check has been queued or is still running. No final result yet."
            : (r.summary || "Verification activity recorded.");
  return {
    id: `verification-${r.id}`,
    kind: "verification",
    status: vs.status,
    statusLabel: vs.label,
    title: r.flow === "shell-nav" ? "Verification check: Main pages" : `Verification check: ${r.flow || "check"}`,
    summary,
    timestamp: r.finishedAt || r.startedAt,
    projectName: attr.projectName,
    projectId: r.projectId,
    attribution: attr.attribution,
    attributionLabel: attr.attributionLabel,
    href: r.projectId ? `/verification?project=${encodeURIComponent(r.projectId)}` : "/verification",
    hrefLabel: "View verification",
    details: [
      { label: "Event type", value: "Verification" },
      { label: "Attribution", value: attr.attributionLabel },
      { label: "Outcome", value: r.outcome },
      { label: "Record ID", value: r.id },
      ...(r.jobId ? [{ label: "Job ID", value: r.jobId }] : []),
      ...(r.projectId ? [{ label: "Project ID", value: r.projectId }] : []),
      ...(r.url ? [{ label: "Target URL", value: r.url }] : []),
      ...(typeof r.exitCode === "number" ? [{ label: "Exit code", value: String(r.exitCode) }] : []),
      ...(r.failingStep ? [{ label: "Failing step", value: r.failingStep }] : []),
      ...(r.evidencePath ? [{ label: "Evidence path", value: r.evidencePath }] : []),
      ...(r.ndjsonPath ? [{ label: "NDJSON log", value: r.ndjsonPath }] : []),
      { label: "Started", value: fmtDate(r.startedAt) },
      ...(r.finishedAt ? [{ label: "Finished", value: fmtDate(r.finishedAt) }] : []),
    ],
    raw: r.stderr || undefined,
  };
}

function mapInvestigation(inv: Investigation, projectNames: Map<string, string>): ActivityItem {
  const status: ActivityStatus = inv.severity === "critical" || inv.severity === "high" ? "attention" : "completed";
  const statusLabel = inv.severity === "critical" || inv.severity === "high" ? "Needs attention" : "Recorded";
  const attr = attributionForProject(inv.projectId ?? undefined, projectNames);
  const summary = inv.simpleExplanation || inv.technicalExplanation || "Issue identified from real project evidence.";
  return {
    id: `investigation-${inv.id}`,
    kind: "investigation",
    status,
    statusLabel,
    title: inv.title || "Issue identified",
    summary,
    timestamp: inv.lastDetectedAt || inv.firstDetectedAt || inv.updatedAt || inv.createdAt,
    projectName: attr.projectName,
    projectId: inv.projectId ?? undefined,
    attribution: attr.attribution,
    attributionLabel: attr.attributionLabel,
    href: "/verification",
    hrefLabel: "View issue details",
    details: [
      { label: "Event type", value: "Issue / Investigation" },
      { label: "Attribution", value: attr.attributionLabel },
      ...(inv.severity ? [{ label: "Severity", value: inv.severity }] : []),
      ...(inv.category ? [{ label: "Category", value: inv.category }] : []),
      { label: "Investigation ID", value: inv.id },
      ...(inv.projectId ? [{ label: "Project ID", value: inv.projectId }] : []),
      ...(inv.status ? [{ label: "Investigation status", value: inv.status }] : []),
      ...(inv.rootCause ? [{ label: "Root cause", value: inv.rootCause }] : []),
      ...(inv.affectedAreas?.length ? [{ label: "Affected areas", value: inv.affectedAreas.join(", ") }] : []),
      ...(inv.evidenceReferences?.length ? [{ label: "Evidence references", value: inv.evidenceReferences.slice(0, 5).join(" | ") }] : []),
      ...(inv.verificationReferences?.length
        ? [{ label: "Verification references", value: inv.verificationReferences.map((v) => `${v.outcome}:${v.verificationId.slice(0, 8)}`).join(", ") }]
        : []),
      { label: "First detected", value: fmtDate(inv.firstDetectedAt) },
      { label: "Last detected", value: fmtDate(inv.lastDetectedAt) },
    ],
  };
}

function mapProjectCommit(c: ProjectObservedCommit, projectNames: Map<string, string>): ActivityItem {
  const shortSha = c.sha.slice(0, 7);
  const files = c.files?.length ? `${c.files.length} file${c.files.length === 1 ? "" : "s"} changed` : "Files changed not recorded";
  const attr = attributionForProject(c.projectId, projectNames);
  return {
    id: `commit-${c.projectId}-${c.repositoryConnectionId}-${c.sha}`,
    kind: "monitoring",
    status: c.processed ? "completed" : "waiting",
    statusLabel: c.processed ? "Recorded" : "Waiting for review",
    title: `Repository update: ${shortSha}`,
    summary: c.message || "A repository change was observed.",
    timestamp: c.date,
    projectName: attr.projectName,
    projectId: c.projectId,
    attribution: "project",
    attributionLabel: "Project-specific",
    href: c.url || undefined,
    hrefLabel: c.url ? "View commit" : undefined,
    details: [
      { label: "Event type", value: "Monitoring / Repository" },
      { label: "Attribution", value: "Project-specific (verified repository link)" },
      { label: "Commit", value: c.sha },
      { label: "Project ID", value: c.projectId },
      { label: "Repository connection", value: c.repositoryConnectionId },
      ...(c.author ? [{ label: "Author", value: c.author }] : []),
      { label: "Files", value: files },
      { label: "Processed by agent", value: c.processed ? "Yes" : "No" },
      { label: "Observed", value: fmtDate(c.date) },
    ],
  };
}

function mapGlobalCommit(c: ObservedCommit): ActivityItem {
  const shortSha = c.sha.slice(0, 7);
  const files = c.files?.length ? `${c.files.length} file${c.files.length === 1 ? "" : "s"} changed` : "Files changed not recorded";
  const repo = (c as ObservedCommit & { repo?: string }).repo;
  return {
    id: `global-commit-${repo || "repo"}-${c.sha}`,
    kind: "monitoring",
    status: c.processed ? "completed" : "waiting",
    statusLabel: c.processed ? "Recorded" : "Waiting for review",
    title: `Repository update: ${shortSha}`,
    summary: c.message || "A repository change was observed.",
    timestamp: c.date,
    projectName: repo || undefined,
    attribution: "global",
    attributionLabel: "Global service event",
    href: c.url || undefined,
    hrefLabel: c.url ? "View commit" : undefined,
    details: [
      { label: "Event type", value: "Monitoring / Repository" },
      { label: "Attribution", value: "Global/shared monitoring event; not assigned to an arbitrary project" },
      { label: "Commit", value: c.sha },
      ...(repo ? [{ label: "Repository", value: repo }] : []),
      ...(c.author ? [{ label: "Author", value: c.author }] : []),
      { label: "Files", value: files },
      { label: "Processed by agent", value: c.processed ? "Yes" : "No" },
      { label: "Observed", value: fmtDate(c.date) },
    ],
  };
}

function mapStory(s: Story, projectNames: Map<string, string>): ActivityItem {
  const status: ActivityStatus = s.status === "published" ? "completed" : s.status === "rejected" ? "blocked" : s.status === "review" ? "waiting" : "processing";
  const statusLabel = s.status === "published" ? "Published" : s.status === "rejected" ? "Rejected / needs revision" : s.status === "review" ? "Waiting for review" : "Draft in progress";
  const storyProjectId = s.projectId || undefined;
  const attr = attributionForProject(storyProjectId, projectNames);
  const ts = s.publishedAt || s.updatedAt || s.createdAt;
  return {
    id: `story-${s.id}`,
    kind: "publishing",
    status,
    statusLabel,
    title: s.title ? `Publishing: ${s.title}` : "Publishing draft",
    summary: s.status === "published"
      ? "A report draft was published from real project records."
      : s.status === "review"
        ? "A report draft is waiting for review before it can be published."
        : s.status === "rejected"
          ? "This draft was rejected and needs revision before it can move forward."
          : "A report draft exists and is still being prepared.",
    timestamp: ts,
    projectName: attr.projectName,
    projectId: storyProjectId,
    attribution: attr.attribution,
    attributionLabel: attr.attributionLabel,
    href: s.status === "published" ? `/reports?report=${encodeURIComponent(s.id)}` : "/editorial",
    hrefLabel: s.status === "published" ? "View report" : "View in Intelligence",
    details: [
      { label: "Event type", value: "Publishing / Intelligence" },
      { label: "Attribution", value: attr.attributionLabel },
      { label: "Story status", value: s.status },
      { label: "Story ID", value: s.id },
      ...(s.slug ? [{ label: "Slug", value: s.slug }] : []),
      ...(storyProjectId ? [{ label: "Project ID", value: storyProjectId }] : []),
      { label: "Created", value: fmtDate(s.createdAt) },
      { label: "Updated", value: fmtDate(s.updatedAt) },
      ...(s.publishedAt ? [{ label: "Published", value: fmtDate(s.publishedAt) }] : []),
    ],
  };
}

function mapRun(run: AgentRun): ActivityItem {
  const status: ActivityStatus = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "processing";
  const statusLabel = run.status === "completed" ? "Completed successfully" : run.status === "failed" ? "Failed" : "Currently processing";
  return {
    id: `run-${run.id}`,
    kind: "run",
    status,
    statusLabel,
    title: `Agent run ${run.trigger === "observe" ? "from observation" : "started manually"}`,
    summary: run.error ? `Run ended with an error: ${run.error}` : `Pipeline run is ${run.status}. Current stage: ${run.currentStage}.`,
    timestamp: run.finishedAt || run.startedAt,
    attribution: "workspace",
    attributionLabel: "Workspace-level event",
    href: "/command-center",
    hrefLabel: "View command center",
    details: [
      { label: "Event type", value: "Agent run" },
      { label: "Attribution", value: "Workspace-level event; not tied to a specific project record" },
      { label: "Run ID", value: run.id },
      { label: "Status", value: run.status },
      { label: "Current stage", value: run.currentStage },
      { label: "Trigger", value: run.trigger },
      { label: "Started", value: fmtDate(run.startedAt) },
      ...(run.finishedAt ? [{ label: "Finished", value: fmtDate(run.finishedAt) }] : []),
      ...(run.error ? [{ label: "Error", value: run.error }] : []),
    ],
  };
}

function mapJournalFallback(e: JournalEvent): ActivityItem {
  const status: ActivityStatus = e.type === "verification" ? "attention" : "completed";
  const refUrl = e.refs?.[0];
  return {
    id: `journal-${e.id}`,
    kind: "note",
    status,
    statusLabel: "Recorded",
    title: e.title || "Activity recorded",
    summary: e.summary || "A journal event was recorded.",
    timestamp: e.timestamp,
    attribution: "unknown",
    attributionLabel: "Historical / unknown attribution",
    href: refUrl || undefined,
    hrefLabel: refUrl ? "View reference" : undefined,
    details: [
      { label: "Event type", value: e.type },
      { label: "Attribution", value: "Historical event with no reliable project attribution" },
      { label: "Journal ID", value: e.id },
      { label: "Source", value: e.source },
      ...(e.refs?.length ? [{ label: "References", value: e.refs.join(", ") }] : []),
      { label: "Recorded", value: fmtDate(e.timestamp) },
    ],
  };
}

function matchesFilter(item: ActivityItem, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "verification") return item.kind === "verification" || item.kind === "run";
  if (filter === "investigation") return item.kind === "investigation";
  if (filter === "monitoring") return item.kind === "monitoring";
  if (filter === "publishing") return item.kind === "publishing";
  return true;
}

function filterLabel(filter: FilterKey): string {
  switch (filter) {
    case "all": return "All activity";
    case "verification": return "Verification";
    case "investigation": return "Issues / investigations";
    case "monitoring": return "Monitoring / repository";
    case "publishing": return "Publishing / intelligence";
  }
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) || {};
  const requestedFilter = typeof sp.filter === "string" ? sp.filter : "all";
  const filter: FilterKey = ["all", "verification", "investigation", "monitoring", "publishing"].includes(requestedFilter)
    ? (requestedFilter as FilterKey)
    : "all";
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const requestedProject = typeof sp.project === "string" ? sp.project.trim() : "all";

  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal);
  const allowLegacy = !principal.userId || principalHasLegacyAccess(principal);

  const projectLookup = await resolveProjectLookup(principal.userId);
  const visibleProjectIdSet = new Set(projectLookup.visibleProjects.map((p) => p.id));

  const [journal, investigations, stories, runs, globalCommits, observationStatus, verification, projectCommitsByProject] = await Promise.all([
    readJournalEvents({ privileged: !!scope.privileged }).catch(() => [] as JournalEvent[]),
    readInvestigations(scope).catch(() => [] as Investigation[]),
    readStories(scope).catch(() => [] as Story[]),
    readRuns(scope).catch(() => [] as AgentRun[]),
    (scope.privileged ? readObservedEvents({ privileged: true, system: true }).catch(() => [] as ObservedCommit[]) : Promise.resolve([] as ObservedCommit[])),
    getObservationStatus({ privileged: !!scope.privileged }).catch(() => ({ config: { owner: "", repo: "", configuredIn: "file" as const }, state: {} as { lastStatus?: string; lastError?: string; lastObservedAt?: string }, eventsCount: 0, tokenConfigured: false, repo: "" })),
    readVerificationRecords({ requestedBy: principal.userId ?? undefined, includeLegacy: allowLegacy }).catch(() => [] as VerificationRecord[]),
    Promise.all(projectLookup.visibleProjects.filter((p) => p.repositoryConnectionId).map(async (p) => {
      const events = await readProjectObservedEvents(p.id, p.repositoryConnectionId as string).catch(() => [] as ProjectObservedCommit[]);
      return events;
    })).then((lists) => lists.flat()),
  ]);

  const scopedInvestigations = investigations.filter((i) => !i.projectId || visibleProjectIdSet.has(i.projectId));
  const scopedStories = stories.filter((s) => !s.projectId || visibleProjectIdSet.has(s.projectId));
  const scopedVerification = verification.filter((r) => {
    if (r.projectId) return visibleProjectIdSet.has(r.projectId);
    return allowLegacy;
  });
  const scopedProjectCommits = projectCommitsByProject.filter((c) => visibleProjectIdSet.has(c.projectId));
  const projectNames = projectLookup.nameById;

  // Global observed commits are shared service events; never assign them to an arbitrary project.
  const globalCommitItems = globalCommits.map(mapGlobalCommit);
  const items: ActivityItem[] = [
    ...scopedVerification.map((r) => mapVerification(r, projectNames)),
    ...scopedInvestigations.map((i) => mapInvestigation(i, projectNames)),
    ...scopedProjectCommits.map((c) => mapProjectCommit(c, projectNames)),
    ...globalCommitItems,
    ...scopedStories.map((s) => mapStory(s, projectNames)),
    ...runs.map(mapRun),
  ];

  // Keep journal as fallback source only when it adds no duplicate commit/verification refs.
  const seenRefs = new Set<string>();
  for (const i of items) {
    if (i.id.startsWith("commit-") || i.id.startsWith("global-commit-")) {
      const sha = i.details.find((d) => d.label === "Commit")?.value;
      if (sha) seenRefs.add(`commit-sha:${sha}`);
    }
    if (i.id.startsWith("verification-")) seenRefs.add(`verification:${i.details.find((d) => d.label === "Record ID")?.value || ""}`);
  }
  for (const e of journal) {
    const verRefFromRefs = e.type === "verification" ? (e.refs || []).find((r) => r.startsWith("verification:")) : undefined;
    if (verRefFromRefs && seenRefs.has(verRefFromRefs)) continue;
    if (e.type === "commit") {
      const sha = (e.refs || []).find((r) => r.startsWith("commit:"))?.slice("commit:".length);
      if (sha && seenRefs.has(`commit-sha:${sha}`)) continue;
    }
    // Avoid duplicating commit/verification journal entries when real records exist.
    if (e.type === "commit" || e.type === "verification") continue;
    items.push(mapJournalFallback(e));
  }

  const deduped = Array.from(new Map(items.map((i) => [i.id, i])).values())
    .filter((i) => i.timestamp && !Number.isNaN(new Date(i.timestamp).getTime()))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const selectedProject = requestedProject !== "all" && visibleProjectIdSet.has(requestedProject) ? requestedProject : "all";
  const filtered = deduped.filter((i) => {
    if (!matchesFilter(i, filter)) return false;
    if (selectedProject !== "all") {
      if (i.attribution === "project") { if (i.projectId !== selectedProject) return false; }
      else if (i.attribution === "global" || i.attribution === "workspace" || i.attribution === "unknown") return false;
    }
    if (!q) return true;
    const hay = [i.title, i.summary, i.statusLabel, i.projectName, i.attributionLabel, ...i.details.map((d) => `${d.label} ${d.value}`)].join(" ").toLowerCase();
    return hay.includes(q);
  });

  const now = Date.now();
  const last24h = deduped.filter((i) => now - new Date(i.timestamp).getTime() <= 24 * 60 * 60 * 1000).length;
  const needsAttention = deduped.filter((i) => ["blocked", "failed", "incomplete", "attention"].includes(i.status)).length;
  const recentCompleted = deduped.filter((i) => i.status === "completed").length;
  const latest = deduped[0];

  const grouped: Array<{ day: string; items: ActivityItem[] }> = [];
  for (const item of filtered) {
    const day = dayKey(item.timestamp);
    const last = grouped[grouped.length - 1];
    if (!last || last.day !== day) grouped.push({ day, items: [item] });
    else last.items.push(item);
  }

  const filters: FilterKey[] = ["all", "verification", "investigation", "monitoring", "publishing"];


  const observationConnected = observationStatus.tokenConfigured || observationStatus.state?.lastStatus === "success" || observationStatus.eventsCount > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="ACTIVITY"
        title="Activity"
        subtitle="A real, chronological record of what KAGURA has observed, checked, investigated, and published. Newest activity appears first."
        actions={<StatusBadge status={observationConnected ? "success" : "idle"} />}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel>
          <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Recent events</div>
          <div className="mt-2 text-2xl font-semibold text-fg">{last24h}</div>
          <div className="mt-1 text-xs text-muted">Recorded in the last 24 hours from persisted activity sources.</div>
        </Panel>
        <Panel>
          <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Events in progress</div>
          <div className="mt-2 text-2xl font-semibold text-fg">{deduped.filter((i) => i.status === "processing" || i.status === "waiting").length}</div>
          <div className="mt-1 text-xs text-muted">Checks or drafts that are still running or waiting for review.</div>
        </Panel>
        <Panel>
          <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Needs attention</div>
          <div className="mt-2 text-2xl font-semibold text-fg">{needsAttention}</div>
          <div className="mt-1 text-xs text-muted">Blocked, failed, incomplete, or issue items that need review.</div>
        </Panel>
        <Panel>
          <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Completed</div>
          <div className="mt-2 text-2xl font-semibold text-fg">{recentCompleted}</div>
          <div className="mt-1 text-xs text-muted">Completed checks, published reports, and recorded events.</div>
        </Panel>
      </section>

      <Panel title="Current activity status" description="Plain-language summary from real persisted records.">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-bg/25 p-4">
              <div className="text-sm font-medium text-fg">Latest event</div>
              {latest ? (
                <div className="mt-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${statusTone(latest.status)}`}>{latest.statusLabel}</span>
                    <span className="text-xs text-muted">{fmtDate(latest.timestamp)}</span>
                  </div>
                  <div className="text-sm text-fg">{latest.title}</div>
                  <div className="text-sm text-muted">{latest.summary}</div>
                </div>
              ) : (
                <div className="mt-2 text-sm text-muted">No activity has been recorded yet.</div>
              )}
            </div>
            <div className="rounded-xl border border-border bg-bg/25 p-4 text-sm text-muted">
              <div className="font-medium text-fg">How to read statuses</div>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed">
                <li><span className="text-emerald-300">Completed successfully</span>: the recorded check or action finished.</li>
                <li><span className="text-sky-300">Currently processing</span> / <span className="text-slate-300">Waiting</span>: work is still running or awaiting review.</li>
                <li><span className="text-amber-300">Blocked / Incomplete</span>: a check could not start or finish. This is not a project pass or fail.</li>
                <li><span className="text-rose-300">Failed</span>: a real check ran and reported a problem.</li>
              </ul>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-bg/25 p-4">
            <div className="text-sm font-medium text-fg">Data sources</div>
            <div className="mt-2 space-y-1 text-xs text-muted">
              <div>Verification records: {scopedVerification.length}</div>
              <div>Investigations/issues: {scopedInvestigations.length}</div>
              <div>Project-attributed repository commits: {scopedProjectCommits.length}</div>
              <div>Global/shared monitoring commits: {globalCommits.length}</div>
              <div>Publishing/story records: {scopedStories.length}</div>
              <div>Agent runs: {runs.length}</div>
              <div>Global monitoring service: {observationConnected ? `Configured${observationStatus.repo ? ` (${observationStatus.repo})` : ""}` : "Not connected / local only"}</div>
              <div>Global observed events in store: {observationStatus.eventsCount}</div>
              <div className="pt-1 text-[11px] text-muted">Global service events are shown as global/shared and are never assigned to an arbitrary project.</div>
            </div>
          </div>
        </div>
      </Panel>


      <Panel title="Activity timeline" description="Newest first. Filter by category or search titles, summaries, IDs, and project names.">
        <div className="space-y-4">
          <form className="flex flex-col gap-3 lg:flex-row lg:items-end" action="/journal" method="get">
            <label className="block flex-1">
              <div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Search activity</div>
              <input
                name="q"
                defaultValue={q}
                placeholder="Search by title, summary, project, status, attribution, or ID"
                className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg outline-none focus:border-accent/50"
              />
            </label>
            <label className="block lg:w-64">
              <div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Project context</div>
              <select name="project" defaultValue={selectedProject} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg">
                <option value="all">All visible projects & global events</option>
                {projectLookup.visibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <input type="hidden" name="filter" value={filter} />
            <button type="submit" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg hover:border-accent/40">Apply</button>
            {(q || filter !== "all" || selectedProject !== "all") && (
              <Link href="/journal" className="rounded-lg border border-border bg-bg/10 px-3 py-2 text-sm text-muted hover:text-fg">Clear</Link>
            )}
          </form>

          <div className="flex flex-wrap gap-2">
            {filters.map((f) => {
              const active = f === filter;
              const params = new URLSearchParams();
              if (f !== "all") params.set("filter", f);
              if (q) params.set("q", q);
              if (selectedProject !== "all") params.set("project", selectedProject);
              const href = params.toString() ? `/journal?${params.toString()}` : "/journal";
              return (
                <Link
                  key={f}
                  href={href}
                  className={`rounded-full border px-3 py-1.5 text-xs ${active ? "border-accent/40 bg-accent/10 text-fg" : "border-border bg-bg/20 text-muted hover:text-fg"}`}
                >
                  {filterLabel(f)}
                </Link>
              );
            })}
          </div>

          <div className="text-xs text-muted">
            Showing {filtered.length} event{filtered.length === 1 ? "" : "s"}{filter !== "all" ? ` in ${filterLabel(filter).toLowerCase()}` : ""}{selectedProject !== "all" ? ` for ${projectLookup.nameById.get(selectedProject) || selectedProject}` : ""}{q ? ` matching "${q}"` : ""}. Project-specific events use verified project attribution; global/shared service events and historical unknown events remain explicitly labeled.
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={deduped.length === 0 ? "No activity yet" : "No activity matches this view"}
              detail={
                deduped.length === 0
                  ? "When KAGURA observes repositories, runs checks, finds issues, or prepares reports, real events will appear here."
                  : "Try a different filter or search term. This page only shows real recorded activity."
              }
            />
          ) : (
            <div className="space-y-6">
              {grouped.map((group) => (
                <section key={group.day} className="space-y-3">
                  <div className="sticky top-0 z-[1] -mx-1 bg-panel/95 px-1 py-1 backdrop-blur">
                    <div className="text-[10px] font-tech uppercase tracking-[0.16em] text-muted">{group.day}</div>
                  </div>
                  <div className="space-y-3">
                    {group.items.map((item) => (
                      <article key={item.id} className="rounded-xl border border-border bg-bg/20 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${statusTone(item.status)}`}>{item.statusLabel}</span>
                              <span className="rounded-full border border-border bg-bg/30 px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] text-muted">{kindLabel(item.kind)}</span>
                              <span className="rounded-full border border-border bg-bg/20 px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] text-muted">{item.attributionLabel}</span>
                              {item.projectName && <span className="text-xs text-muted">Project: <span className="text-fg/85">{item.projectName}</span></span>}
                            </div>
                            <div>
                              <div className="text-sm font-medium text-fg">{item.title}</div>
                              <div className="mt-1 text-sm text-muted">{item.summary}</div>
                            </div>
                            <div className="text-xs text-muted">{fmtDate(item.timestamp)}</div>
                          </div>
                          {item.href && (
                            <Link href={item.href} className="shrink-0 rounded-lg border border-border bg-bg/30 px-3 py-2 text-xs text-fg hover:border-accent/40">
                              {item.hrefLabel || "View details"}
                            </Link>
                          )}
                        </div>

                        <details className="mt-3 rounded-lg border border-border/70 bg-bg/15 p-3">
                          <summary className="cursor-pointer text-xs font-medium text-fg/90">Details</summary>
                          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                            {item.details.map((d) => (
                              <div key={`${item.id}-${d.label}`} className="rounded-md border border-border/60 bg-bg/20 px-3 py-2">
                                <dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">{d.label}</dt>
                                <dd className="mt-1 break-words text-xs text-fg/90">{d.value}</dd>
                              </div>
                            ))}
                          </dl>
                          {item.raw && (
                            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/30 p-3 text-[11px] text-muted">{item.raw}</pre>
                          )}
                        </details>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
