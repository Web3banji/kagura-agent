import Link from "next/link";
import { PageHeader, Panel, EmptyState, WorkflowStrip } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { readVerificationRecords, summarizeOutcome } from "@/lib/verification/store";
import { readRuns } from "@/lib/agent/runs";
import { readInvestigations } from "@/lib/investigations/store";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getObservationStatus } from "@/lib/github/observe";
import { readObservedEvents, readProjectObservedEvents } from "@/lib/github/store";
import { resolveProjectIdsForUser } from "@/lib/verification/context";
import { resolveSelectedProjectId, recordVisibleInContext } from "@/lib/command-center/context";
import { stageDetail, stageLabel, statusInfo } from "@/lib/ui-text";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import { RunPipelineButton } from "@/app/(dashboard)/command-center/run-button";
import { ObserveButton } from "@/app/(dashboard)/command-center/observe-button";

export const dynamic = "force-dynamic";

type ProjectInfo = { id: string; name: string; slug: string; repo: string | null; repositoryConnectionId?: string | null };

async function readVisibleProjects(userId: string | undefined): Promise<ProjectInfo[]> {
  if (!hasDatabase() || !userId) return [];
  try {
    await ensureDb();
    const res = await getPool().query(
      `SELECT p.id, p.name, p.slug, rc.full_name, rc.id AS repository_connection_id
       FROM projects p
       LEFT JOIN project_repository_links prl ON prl.project_id = p.id AND prl.owner_user_id = p.owner_user_id AND prl.link_status = 'active'
       LEFT JOIN repository_connections rc ON rc.id = prl.repository_connection_id AND rc.owner_user_id = p.owner_user_id
       WHERE p.owner_user_id = $1
       ORDER BY p.is_bootstrap DESC, p.created_at DESC`,
      [userId],
    );
    return (res.rows as Array<{ id?: string; name?: string; slug?: string; full_name?: string | null; repository_connection_id?: string | null }>).map((row) => ({
      id: String(row.id),
      name: String(row.name || "Project"),
      slug: String(row.slug || row.id),
      repo: row.full_name ? String(row.full_name) : null,
      repositoryConnectionId: row.repository_connection_id ? String(row.repository_connection_id) : null,
    }));
  } catch {
    return [];
  }
}

function fmtDate(value?: string | null): string {
  if (!value) return "Not yet";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Not yet";
  return d.toLocaleString();
}

function healthTone(kind: "ok" | "warn" | "bad" | "neutral") {
  switch (kind) {
    case "ok": return "text-emerald-300 border-emerald-500/25 bg-emerald-500/5";
    case "warn": return "text-amber-300 border-amber-500/25 bg-amber-500/5";
    case "bad": return "text-rose-300 border-rose-500/25 bg-rose-500/5";
    default: return "text-muted border-border bg-panel-2/30";
  }
}

function severityLabel(severity: string | null | undefined): string {
  if (!severity) return "Not rated";
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function severityTone(severity: string | null | undefined): string {
  switch (severity) {
    case "critical": return "text-rose-200 bg-rose-500/15 border-rose-500/30";
    case "high": return "text-rose-300 bg-rose-500/10 border-rose-500/25";
    case "medium": return "text-amber-300 bg-amber-500/10 border-amber-500/25";
    case "low": return "text-sky-300 bg-sky-500/10 border-sky-500/25";
    default: return "text-muted bg-white/[0.03] border-border";
  }
}

export async function CommandCenterSection({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) || {};
  const requestedProject = typeof sp.project === "string" ? sp.project.trim() : "";
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const visibleProjects = await readVisibleProjects(principal.userId);
  const visibleProjectIds = visibleProjects.map((p) => p.id);
  const fallbackVisibleIds = visibleProjectIds.length > 0 ? visibleProjectIds : (principal.userId ? await resolveProjectIdsForUser(principal.userId) : []);
  const allowLegacy = !principal.userId || principalHasLegacyAccess(principal);
  const selectedProjectId = resolveSelectedProjectId(requestedProject, fallbackVisibleIds);
  const selectedProject = selectedProjectId === "all" ? null : visibleProjects.find((p) => p.id === selectedProjectId) || { id: selectedProjectId, name: "Project", slug: selectedProjectId, repo: null };
  const context = { selectedProjectId, visibleProjectIds: fallbackVisibleIds, allowLegacy };

  const [pipeline, allVerifications, runs, obsStatus, globalObservedEvents, investigations, projectObservedEvents] = await Promise.all([
    getCurrentPipelineState(),
    readVerificationRecords({
      requestedBy: scope.privileged ? undefined : principal.userId,
      includeLegacy: allowLegacy,
    }),
    readRuns(scope),
    getObservationStatus({ privileged: !!scope.privileged }),
    (scope.privileged ? readObservedEvents({ privileged: true, system: true }).catch(() => []) : Promise.resolve([])),
    readInvestigations(scope).catch(() => []),
    (async () => {
      if (selectedProjectId === "all") return [];
      const project = visibleProjects.find((p) => p.id === selectedProjectId);
      if (!project?.repositoryConnectionId) return [];
      return readProjectObservedEvents(selectedProjectId, project.repositoryConnectionId).catch(() => []);
    })(),
  ]);

  const verifications = allVerifications.filter((v) => recordVisibleInContext(v, context));
  const scopedInvestigations = investigations.filter((i) => recordVisibleInContext(i, context));
  const observedEvents = selectedProjectId === "all" ? globalObservedEvents : projectObservedEvents;

  const summary = summarizeOutcome(verifications);
  const latestVerification = verifications[0];
  const latestRun = runs[0];
  const recentEvents = observedEvents.slice(0, 6);
  const recentRuns = runs.slice(0, 5);
  const openInvestigations = scopedInvestigations
    .filter((i) => i.status === "open")
    .sort((a, b) => new Date(b.lastDetectedAt).getTime() - new Date(a.lastDetectedAt).getTime());
  const recentInvestigationActivity = scopedInvestigations
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 4);

  const hasEverRun = runs.length > 0 || observedEvents.length > 0 || verifications.length > 0 || scopedInvestigations.length > 0;
  const projectScopeLabel = selectedProjectId === "all"
    ? `All projects (${visibleProjects.length || fallbackVisibleIds.length})`
    : selectedProject?.name || "Selected project";
  const projectRepoLabel = selectedProjectId === "all"
    ? (visibleProjects.length ? `${visibleProjects.filter((p) => p.repo).length} of ${visibleProjects.length} projects have an assigned repository` : "No project selected")
    : (selectedProject?.repo || "No repository assigned");
  const contextNote = selectedProjectId === "all"
    ? "Showing aggregated information across projects visible to your account. Metrics are scoped to those projects and do not assume a single project."
    : `Showing information for ${selectedProject?.name || "the selected project"} only.`;
  const agentInfo = statusInfo(pipeline.agentState);
  const latestOutcome = latestVerification?.outcome ?? "none";
  const blockedCount = summary.blocked;
  const incompleteCount = verifications.filter((v) => ["pending", "running", "timeout", "blocked", "did_not_start"].includes(v.outcome)).length;
  const confirmedIssues = openInvestigations.length;
  const successfulChecks = summary.passed;

  const monitoringState = pipeline.agentState === "running"
    ? "Checking now"
    : obsStatus.state.lastObservedAt
      ? "Monitoring active"
      : "Not checked yet";
  const monitoringDetail = pipeline.agentState === "running"
    ? "KAGURA is currently running a check."
    : obsStatus.state.lastObservedAt
      ? `Last looked at your project on ${fmtDate(obsStatus.state.lastObservedAt)}.`
      : "No project check has been recorded yet.";

  const nextAction = (() => {
    if (pipeline.agentState === "running") {
      return {
        title: "Wait for the current check to finish",
        detail: "KAGURA is working right now. You can review the current situation below while it runs.",
        href: "/command-center",
        cta: "Refresh page",
        useRunButton: false,
      };
    }
    if (openInvestigations.length > 0) {
      const top = openInvestigations[0];
      return {
        title: "Review the confirmed issue",
        detail: `KAGURA found an issue that needs attention: "${top.title}". Review the evidence and use the fix prompt when you are ready.`,
        href: "/verification",
        cta: "See evidence",
        useRunButton: false,
      };
    }
    if (latestOutcome === "blocked" || latestOutcome === "did_not_start" || latestOutcome === "timeout") {
      return {
        title: "Check why testing could not finish",
        detail: "The latest test did not complete cleanly. This is not a pass or fail. Review setup and connection details before relying on it.",
        href: "/verification",
        cta: "View test details",
        useRunButton: false,
      };
    }
    if (!hasEverRun) {
      return {
        title: "Start your first check",
        detail: "Run a check to look for project changes, test real behavior, and generate evidence-based findings.",
        href: "/command-center",
        cta: "Start a new check",
        useRunButton: true,
      };
    }
    return {
      title: "Run another check when you make changes",
      detail: "No open confirmed issues are currently recorded. When you update the project, run a check to verify what changed.",
      href: "/command-center",
      cta: "Start a new check",
      useRunButton: true,
    };
  })();

  return (
    <div data-page="command-center" className="space-y-6">
      <PageHeader
        title="Command Center"
        subtitle="A clear view of your project, what KAGURA found, and what to do next."
        actions={
          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start w-full md:w-auto">
            <ObserveButton />
            <RunPipelineButton />
          </div>
        }
      />

      <Panel title="Project context" description="Choose which project context to view. All projects is the default and never silently picks a first/bootstrap project.">
        <form action="/command-center" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block flex-1">
            <div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">View context</div>
            <select name="project" defaultValue={selectedProjectId} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg">
              <option value="all">All projects</option>
              {visibleProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.repo ? ` (${p.repo})` : ""}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg hover:border-accent/40">Apply</button>
          {selectedProjectId !== "all" ? <Link href="/command-center" className="rounded-lg border border-border bg-bg/10 px-3 py-2 text-sm text-muted hover:text-fg">All projects</Link> : null}
        </form>
        <div className="mt-3 text-xs text-muted">{contextNote}</div>
        {requestedProject && requestedProject !== "all" && !fallbackVisibleIds.includes(requestedProject) ? (
          <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-200">
            The requested project context is not accessible. Showing All projects instead.
          </div>
        ) : null}
      </Panel>

      {!hasEverRun ? (
        <section className="rounded-xl border border-accent/25 bg-accent-soft/10 p-5 md:p-6">
          <div className="k-label text-accent/90 mb-2">Getting started</div>
          <h2 className="text-xl font-semibold text-fg">Welcome to KAGURA</h2>
          <p className="mt-2 text-sm text-muted max-w-3xl leading-relaxed">
            KAGURA watches real project activity, runs real checks, and explains what it finds in plain language. It never invents results.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-panel/50 p-4"><div className="text-sm font-medium text-fg">1. Check your project</div><p className="mt-1 text-xs text-muted">Look for recent changes and test what matters.</p></div>
            <div className="rounded-lg border border-border bg-panel/50 p-4"><div className="text-sm font-medium text-fg">2. Review findings</div><p className="mt-1 text-xs text-muted">See confirmed issues, evidence, and plain-language explanations.</p></div>
            <div className="rounded-lg border border-border bg-panel/50 p-4"><div className="text-sm font-medium text-fg">3. Decide next step</div><p className="mt-1 text-xs text-muted">Fix, recheck, or publish only when evidence supports it.</p></div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="rounded-xl border border-border/90 bg-panel/80 p-5 md:p-6 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="k-label text-accent/80 mb-2">Current situation</div>
              <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-fg">{agentInfo.label}</h2>
              <p className="mt-2 text-sm md:text-base text-muted max-w-3xl leading-relaxed">
                {pipeline.note || agentInfo.description}
              </p>
            </div>
            <StatusBadge status={pipeline.agentState} />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-panel-2/30 p-4">
              <div className="text-xs text-muted uppercase tracking-[0.12em]">Current step</div>
              <div className="mt-2 text-sm font-medium text-fg" data-testid="pipeline-stage">{stageLabel(pipeline.stage)}</div>
              <p className="mt-1 text-xs text-muted leading-relaxed">{stageDetail(pipeline.stage)}</p>
            </div>
            <div className="rounded-lg border border-border bg-panel-2/30 p-4">
              <div className="text-xs text-muted uppercase tracking-[0.12em]">Last check</div>
              <div className="mt-2 text-sm font-medium text-fg">{fmtDate(pipeline.lastRunAt)}</div>
              <p className="mt-1 text-xs text-muted leading-relaxed">
                {latestVerification ? `Latest test result: ${statusInfo(latestVerification.outcome).label}.` : "No test result recorded yet."}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-panel-2/30 p-4">
              <div className="text-xs text-muted uppercase tracking-[0.12em]">What this means</div>
              <div className="mt-2 text-sm font-medium text-fg">
                {latestOutcome === "blocked" || latestOutcome === "did_not_start" || latestOutcome === "timeout"
                  ? "Testing incomplete"
                  : latestOutcome === "failed"
                    ? "Issue needs attention"
                    : latestOutcome === "passed"
                      ? "Latest check passed"
                      : "Waiting for evidence"}
              </div>
              <p className="mt-1 text-xs text-muted leading-relaxed">
                {latestOutcome === "blocked" || latestOutcome === "did_not_start" || latestOutcome === "timeout"
                  ? "A check that could not finish is not a pass or a fail."
                  : latestOutcome === "failed"
                    ? "Review the confirmed issue and supporting evidence below."
                    : latestOutcome === "passed"
                      ? "The latest recorded check passed, but only for what it covered."
                      : "Run a check to get real results."}
              </p>
            </div>
          </div>

          {pipeline.lastError ? (
            <div className="mt-4 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-rose-200">
              <span className="font-medium">Something needs attention: </span>{pipeline.lastError}
            </div>
          ) : null}
        </div>

        <Panel title="Project overview" description={selectedProjectId === "all" ? "Aggregate view across all projects visible to your account." : "The selected project KAGURA is currently showing."}>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-muted">Context</dt>
              <dd className="mt-1 font-medium text-fg">{projectScopeLabel}</dd>
              <dd className="text-xs text-muted mt-0.5 break-all">{selectedProjectId === "all" ? "Aggregated across visible projects" : `ID: ${selectedProject?.id}`}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-muted">Assigned repository</dt>
              <dd className="mt-1 font-medium text-fg break-all">{projectRepoLabel}</dd>
              <dd className="text-xs text-muted mt-0.5">{selectedProjectId === "all" ? "Repository assignment varies by project." : `Source: ${obsStatus.tokenConfigured ? "GitHub connected" : "Local/git configuration"}`}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-muted">Monitoring status</dt>
              <dd className="mt-1 flex items-center gap-2">
                <span className={`inline-flex h-2 w-2 rounded-full ${pipeline.agentState === "running" ? "bg-accent" : obsStatus.state.lastStatus === "failed" ? "bg-rose-400" : obsStatus.state.lastObservedAt ? "bg-emerald-400" : "bg-muted-soft"}`} />
                <span className="font-medium text-fg">{monitoringState}</span>
              </dd>
              <dd className="text-xs text-muted mt-1 leading-relaxed">{selectedProjectId === "all" ? "Global monitoring status is shown for shared observation services; project-specific evidence below is scoped to visible projects." : monitoringDetail}</dd>
            </div>
          </dl>
          <details className="mt-4 text-xs text-muted">
            <summary className="cursor-pointer text-accent">Technical details</summary>
            <div className="mt-2 space-y-1 break-all">
              <div>Context: {selectedProjectId === "all" ? "all" : selectedProject?.id}</div>
              {selectedProjectId !== "all" ? <div>Project slug: {selectedProject?.slug}</div> : <div>Visible projects: {visibleProjects.length || fallbackVisibleIds.length}</div>}
              <div>Observation config: {obsStatus.config.configuredIn}</div>
              <div>Global events saved: {obsStatus.eventsCount}</div>
              <div>Last observation status: {obsStatus.state.lastStatus ?? "never"}</div>
            </div>
          </details>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Panel title="Project health" description={selectedProjectId === "all" ? "Real counts aggregated across projects visible to your account. No score is calculated." : "Real counts from recorded checks and investigations for the selected project. No score is calculated."}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className={`rounded-lg border p-4 ${healthTone(confirmedIssues > 0 ? "bad" : "neutral")}`}>
              <div className="text-xs uppercase tracking-[0.12em] opacity-80">Confirmed issues</div>
              <div className="mt-2 text-2xl font-semibold">{confirmedIssues}</div>
              <p className="mt-1 text-xs opacity-80 leading-relaxed">Open issues backed by verification evidence.</p>
            </div>
            <div className={`rounded-lg border p-4 ${healthTone(successfulChecks > 0 ? "ok" : "neutral")}`}>
              <div className="text-xs uppercase tracking-[0.12em] opacity-80">Successful checks</div>
              <div className="mt-2 text-2xl font-semibold">{successfulChecks}</div>
              <p className="mt-1 text-xs opacity-80 leading-relaxed">Checks that finished and passed.</p>
            </div>
            <div className={`rounded-lg border p-4 ${healthTone(blockedCount > 0 ? "warn" : "neutral")}`}>
              <div className="text-xs uppercase tracking-[0.12em] opacity-80">Blocked checks</div>
              <div className="mt-2 text-2xl font-semibold">{blockedCount}</div>
              <p className="mt-1 text-xs opacity-80 leading-relaxed">Checks that could not start or finish due to setup/connection issues.</p>
            </div>
            <div className={`rounded-lg border p-4 ${healthTone(incompleteCount > 0 ? "warn" : "neutral")}`}>
              <div className="text-xs uppercase tracking-[0.12em] opacity-80">Incomplete verification</div>
              <div className="mt-2 text-2xl font-semibold">{incompleteCount}</div>
              <p className="mt-1 text-xs opacity-80 leading-relaxed">Pending, running, timed out, or blocked checks. Incomplete is not a pass.</p>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-border bg-panel-2/20 p-3 text-xs text-muted leading-relaxed">
            <span className="text-fg font-medium">How to read this: </span>
            Confirmed issues come from investigation evidence. Successful checks mean a recorded check passed. Blocked or incomplete checks mean KAGURA cannot treat the project as verified by those runs.
          </div>
        </Panel>

        <Panel title="Next action" description="Based on the current real state of your project.">
          <div className="rounded-lg border border-accent/20 bg-accent-soft/10 p-4">
            <div className="k-label text-accent/80 mb-2">Recommended</div>
            <h3 className="text-base font-semibold text-fg">{nextAction.title}</h3>
            <p className="mt-2 text-sm text-muted leading-relaxed">{nextAction.detail}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {nextAction.useRunButton ? (
                <RunPipelineButton />
              ) : (
                <Link href={nextAction.href} className="inline-flex items-center px-4 py-2.5 rounded-md bg-accent text-black font-tech uppercase tracking-[0.12em] text-xs font-bold hover:brightness-110 shadow-glow">
                  {nextAction.cta}
                </Link>
              )}
              <Link href={selectedProjectId === "all" ? "/verification" : `/verification?project=${encodeURIComponent(selectedProjectId)}`} className="inline-flex items-center px-4 py-2.5 rounded-md border border-border-strong bg-panel-2/40 font-tech uppercase tracking-[0.12em] text-[11px] text-fg hover:border-accent/40">
                Open checks
              </Link>
            </div>
          </div>
          <div className="mt-4 space-y-2 text-xs text-muted">
            <div className="flex items-center justify-between gap-3"><span>Recent observed changes</span><span className="text-fg font-medium">{recentEvents.length}</span></div>
            <div className="flex items-center justify-between gap-3"><span>Latest test outcome</span><span className="text-fg font-medium">{statusInfo(latestOutcome).label}</span></div>
          </div>
        </Panel>
      </section>

      <Panel title="What KAGURA discovered" description="Plain-language findings from real investigation records and supporting evidence.">
        {openInvestigations.length === 0 ? (
          <EmptyState
            title="No confirmed issues right now"
            detail={latestOutcome === "passed"
              ? "The latest recorded check passed. KAGURA has not recorded an open confirmed issue for this project."
              : "KAGURA has not recorded an open confirmed issue. If you recently changed the project, run a check to gather evidence."}
            action={<Link href="/verification" className="text-sm text-accent underline">View checks &amp; tests</Link>}
          />
        ) : (
          <div className="space-y-4">
            {openInvestigations.slice(0, 4).map((inv) => {
              const refs = inv.verificationReferences || [];
              const latestRef = refs[refs.length - 1];
              return (
                <article key={inv.id} className="rounded-lg border border-border bg-panel-2/20 p-4 md:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm md:text-base font-semibold text-fg">{inv.title}</h3>
                        <span className={`inline-flex items-center text-[11px] font-tech uppercase tracking-[0.12em] px-2 py-1 rounded border ${severityTone(inv.severity)}`}>
                          {severityLabel(inv.severity)}
                        </span>
                        <StatusBadge status={inv.status === "resolved" ? "completed" : "failed"} />
                      </div>
                      <p className="mt-2 text-sm text-muted leading-relaxed max-w-4xl">
                        {inv.simpleExplanation || inv.technicalExplanation || "KAGURA recorded an issue, but no plain-language explanation is available yet."}
                      </p>
                    </div>
                    <div className="text-xs text-muted shrink-0">
                      <div>Last seen: {fmtDate(inv.lastDetectedAt)}</div>
                      <div className="mt-1">Evidence: {refs.length} verification reference{refs.length === 1 ? "" : "s"}</div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3 text-xs">
                    <div className="rounded border border-border/80 bg-panel/40 p-3">
                      <div className="text-muted uppercase tracking-[0.12em]">Expected</div>
                      <div className="mt-1 text-fg/90 leading-relaxed">{inv.expectedBehaviour || "Not recorded."}</div>
                    </div>
                    <div className="rounded border border-border/80 bg-panel/40 p-3">
                      <div className="text-muted uppercase tracking-[0.12em]">What happened</div>
                      <div className="mt-1 text-fg/90 leading-relaxed">{inv.actualBehaviour || inv.rootCause || "See evidence details."}</div>
                    </div>
                    <div className="rounded border border-border/80 bg-panel/40 p-3">
                      <div className="text-muted uppercase tracking-[0.12em]">Affected area</div>
                      <div className="mt-1 text-fg/90 leading-relaxed">{inv.affectedAreas?.length ? inv.affectedAreas.join(", ") : "Not identified from evidence."}</div>
                    </div>
                  </div>

                  <details className="mt-4 text-xs text-muted">
                    <summary className="cursor-pointer text-accent">Technical evidence &amp; fix prompt</summary>
                    <div className="mt-3 space-y-3">
                      {latestRef ? (
                        <div className="rounded border border-border bg-black/10 p-3 space-y-1 break-all">
                          <div>Latest verification: <span className="font-mono">{latestRef.verificationId}</span></div>
                          <div>Outcome: {latestRef.outcome}</div>
                          {latestRef.failingStep ? <div>Failing step: {latestRef.failingStep}</div> : null}
                          {latestRef.evidencePath ? <div>Evidence path: <span className="font-mono">{latestRef.evidencePath}</span></div> : null}
                        </div>
                      ) : null}
                      {inv.technicalExplanation ? (
                        <div>
                          <div className="text-muted mb-1">Technical explanation</div>
                          <pre className="whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/85 overflow-x-auto">{inv.technicalExplanation}</pre>
                        </div>
                      ) : null}
                      {inv.aiFixPrompt ? (
                        <div>
                          <div className="text-muted mb-1">AI fix prompt</div>
                          <pre className="whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/85 overflow-x-auto">{inv.aiFixPrompt}</pre>
                        </div>
                      ) : null}
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Panel title="Activity" description="Recent genuine checks and investigation activity.">
          <div className="space-y-6">
            <div>
              <h3 className="text-xs font-tech uppercase tracking-[0.14em] text-muted mb-3">Recent checks</h3>
              {recentRuns.length === 0 ? (
                <p className="text-sm text-muted">No checks have run yet.</p>
              ) : (
                <ul className="space-y-2">
                  {recentRuns.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-panel-2/20 p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-fg">{fmtDate(r.startedAt)}</div>
                        <div className="text-xs text-muted mt-0.5">
                          Step: {stageLabel(r.currentStage)}
                          {r.observation ? ` · ${r.observation.newCount} new update${r.observation.newCount === 1 ? "" : "s"}` : ""}
                        </div>
                        {r.error ? <div className="text-xs text-rose-300 mt-1 line-clamp-2">{r.error}</div> : null}
                      </div>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-xs font-tech uppercase tracking-[0.14em] text-muted mb-3">Investigation activity</h3>
              {recentInvestigationActivity.length === 0 ? (
                <p className="text-sm text-muted">No investigation activity recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {recentInvestigationActivity.map((inv) => (
                    <li key={inv.id} className="rounded-lg border border-border bg-panel-2/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-fg truncate">{inv.title}</div>
                          <div className="text-xs text-muted mt-0.5">
                            {inv.status === "open" ? "Open issue" : inv.status === "resolved" ? "Resolved" : "Superseded"} · Updated {fmtDate(inv.updatedAt)}
                          </div>
                        </div>
                        <span className={`inline-flex items-center text-[11px] font-tech uppercase tracking-[0.12em] px-2 py-1 rounded border ${severityTone(inv.severity)}`}>
                          {severityLabel(inv.severity)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <details className="text-xs text-muted">
              <summary className="cursor-pointer text-accent">Recent project changes</summary>
              {recentEvents.length === 0 ? (
                <p className="mt-2">No project changes recorded yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-panel-2/10">
                  {recentEvents.map((c) => (
                    <li key={c.sha} className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm text-fg/90">{c.message}</div>
                        <span className="text-[11px] text-muted shrink-0">{c.processed ? "Reviewed" : "New"}</span>
                      </div>
                      <div className="text-[11px] text-muted mt-1">{c.author} · {fmtDate(c.date)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
        </Panel>

        <Panel title="Workflow" description="The six-stage agent workflow KAGURA follows.">
          <WorkflowStrip current={pipeline.stage} />
          <div className="mt-4 rounded-lg border border-border bg-panel-2/20 p-4">
            <div className="text-xs uppercase tracking-[0.12em] text-muted">Current stage</div>
            <div className="mt-1 text-sm font-medium text-fg">{stageLabel(pipeline.stage)}</div>
            <p className="mt-2 text-sm text-muted leading-relaxed">{stageDetail(pipeline.stage)}</p>
          </div>
          <details className="mt-4 text-xs text-muted">
            <summary className="cursor-pointer text-accent">Latest check stage details</summary>
            {latestRun ? (
              <div className="mt-3 space-y-2">
                {latestRun.stages.map((st) => (
                  <div key={st.stage} className="flex items-start justify-between gap-3 rounded border border-border bg-panel-2/20 p-2.5">
                    <div>
                      <div className="text-fg/90 font-medium">{stageLabel(st.stage)}</div>
                      <div className="text-[11px] text-muted mt-0.5">{st.note || statusInfo(st.status).description}</div>
                    </div>
                    <StatusBadge status={st.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2">No check has run yet.</p>
            )}
          </details>
        </Panel>
      </section>
    </div>
  );
}