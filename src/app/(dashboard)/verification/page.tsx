import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readVerificationRecords, summarizeOutcome } from "@/lib/verification/store";
import { readInvestigations } from "@/lib/investigations/store";
import { readJobs, getRunnerHeartbeat } from "@/lib/verification/jobs";
import { RerunVerificationButton } from "./rerun-button";
import { statusInfo } from "@/lib/ui-text";
import { resolveProjectIdsForUser, resolveProjectId } from "@/lib/verification/context";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import type { VerificationRecord } from "@/types/verification";
import type { Investigation } from "@/types/investigation";

export const dynamic = "force-dynamic";

type ProjectMeta = { id: string; name: string; repo: string | null };

function fmtDate(value?: string | null): string {
  if (!value) return "Not recorded";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  return d.toLocaleString();
}

function fmtDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isInfraOutcome(outcome: string): boolean {
  return outcome === "blocked" || outcome === "did_not_start" || outcome === "timeout";
}

function isIncomplete(outcome: string): boolean {
  return outcome === "pending" || outcome === "running";
}

function outcomePlain(outcome: string): { label: string; tone: "ok" | "bad" | "warn" | "neutral"; detail: string } {
  if (outcome === "passed") return { label: "Successful check", tone: "ok", detail: "The check finished and did not report a problem for what it tested." };
  if (outcome === "failed") return { label: "Genuine issue found", tone: "bad", detail: "The check finished and reported a problem that needs attention." };
  if (outcome === "blocked" || outcome === "did_not_start") return { label: "Could not run", tone: "warn", detail: "The check could not start or finish because of setup, connection, or execution problems. This is not a pass or fail." };
  if (outcome === "timeout") return { label: "Took too long", tone: "warn", detail: "The check ran out of time before it finished. This is incomplete, not a pass or fail." };
  if (outcome === "pending" || outcome === "running") return { label: "In progress", tone: "neutral", detail: "This check has not finished yet. Wait for the real result before drawing conclusions." };
  return { label: "No check yet", tone: "neutral", detail: "No verification has been recorded yet." };
}

function toneClasses(tone: "ok" | "bad" | "warn" | "neutral"): string {
  switch (tone) {
    case "ok": return "border-emerald-500/25 bg-emerald-500/5 text-emerald-200";
    case "bad": return "border-rose-500/25 bg-rose-500/5 text-rose-200";
    case "warn": return "border-amber-500/25 bg-amber-500/5 text-amber-200";
    default: return "border-border bg-panel-2/20 text-fg/90";
  }
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

function severityLabel(severity: string | null | undefined): string {
  if (!severity) return "Not rated";
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

async function resolveProjectMeta(projectIds: string[], userId: string | undefined): Promise<Map<string, ProjectMeta>> {
  const map = new Map<string, ProjectMeta>();
  for (const id of projectIds) map.set(id, { id, name: id, repo: null });
  if (!hasDatabase() || !userId || projectIds.length === 0) return map;
  try {
    await ensureDb();
    const res = await getPool().query(
      `SELECT p.id, p.name, rc.full_name
       FROM projects p
       LEFT JOIN project_repository_links prl ON prl.project_id = p.id AND prl.link_status = 'active'
       LEFT JOIN repository_connections rc ON rc.id = prl.repository_connection_id
       WHERE p.owner_user_id = $1 AND p.id = ANY($2::text[])`,
      [userId, projectIds],
    );
    for (const row of res.rows as Array<{ id: string; name: string; full_name: string | null }>) {
      map.set(String(row.id), { id: String(row.id), name: String(row.name || row.id), repo: row.full_name ? String(row.full_name) : null });
    }
  } catch {}
  return map;
}

function investigationsForRecord(record: VerificationRecord, investigations: Investigation[]): Investigation[] {
  const byId = new Set(record.investigationIds || []);
  return investigations.filter((inv) => byId.has(inv.id) || inv.verificationReferences.some((ref) => ref.verificationId === record.id || (record.jobId && ref.jobId === record.jobId)));
}

function infraCause(record: VerificationRecord): { cause: string; next: string } {
  const text = `${record.summary || ""} ${record.stderr || ""} ${""}`.toLowerCase();
  if (record.outcome === "timeout") return { cause: "The check took too long to finish.", next: "Try running the check again. If it keeps timing out, review the runner, target app, or test flow." };
  if (text.includes("unauthorized") || text.includes("401") || text.includes("credential") || text.includes("token") || text.includes("auth")) return { cause: "Credentials or access may be missing or invalid.", next: "Check GitHub/Kane/runner credentials and reconnect if needed, then run the check again." };
  if (text.includes("runner") || text.includes("heartbeat") || text.includes("lease") || text.includes("queue")) return { cause: "The local runner may not be connected or available.", next: "Make sure the KAGURA runner is running and connected, then queue the check again." };
  if (text.includes("browser") || text.includes("chrome") || text.includes("profile")) return { cause: "The browser or test environment may not be ready.", next: "Check that a supported browser is installed and the runner environment is healthy." };
  if (text.includes("network") || text.includes("econn") || text.includes("url") || text.includes("dns")) return { cause: "The test could not reach the app or a required service.", next: "Confirm the app URL is reachable and the environment is running, then try again." };
  return { cause: "The check could not start or finish. The available evidence does not confirm an application issue.", next: "Review technical details, check runner/setup status, and run the check again when the environment is ready." };
}

export default async function VerificationLabPage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });

  let projectIds: string[] = [];
  if (scope.userId) {
    try { projectIds = await resolveProjectIdsForUser(scope.userId); } catch {}
  }
  if (!projectIds.length) {
    const single = await resolveProjectId();
    if (single) projectIds.push(single);
  }

  const [recordsPerProject, investigations, jobs, runnerHeartbeat, projectMeta] = await Promise.all([
    Promise.all(projectIds.map((projectId) => readVerificationRecords({ projectId, includeLegacy: !!scope.includeLegacy, requestedBy: scope.privileged ? undefined : principal.userId }).catch(() => [] as VerificationRecord[]))),
    readInvestigations(scope).catch(() => [] as Investigation[]),
    readJobs({ requestedBy: scope.privileged ? undefined : principal.userId, includeLegacy: !!scope.includeLegacy }).catch(() => []),
    getRunnerHeartbeat().catch(() => ({ status: "disconnected" as const, note: "Runner status unavailable." })),
    resolveProjectMeta(projectIds, principal.userId),
  ]);

  const seen = new Set<string>();
  const allRecords: VerificationRecord[] = [];
  for (const records of recordsPerProject) {
    for (const r of records) {
      if (!seen.has(r.id)) { seen.add(r.id); allRecords.push(r); }
    }
  }
  allRecords.sort((a, b) => new Date(b.startedAt || b.finishedAt || 0).getTime() - new Date(a.startedAt || a.finishedAt || 0).getTime());

  const summary = summarizeOutcome(allRecords);
  const latest = allRecords[0];
  const latestPlain = outcomePlain(latest?.outcome ?? "none");
  const openInvestigations = investigations.filter((i) => i.status === "open");
  const confirmedIssueCount = openInvestigations.length;
  const infraRecords = allRecords.filter((r) => isInfraOutcome(r.outcome));
  const incompleteRecords = allRecords.filter((r) => isIncomplete(r.outcome));
  const activeJobs = jobs.filter((j) => j.status === "pending" || j.status === "claimed" || j.status === "running");

  const latestProjectId = latest?.projectId || projectIds[0] || "default";
  const latestProject = projectMeta.get(latestProjectId) || { id: latestProjectId, name: latestProjectId, repo: null };

  const nextAction = (() => {
    if (activeJobs.length > 0 || incompleteRecords.length > 0) return { title: "Wait for the check to finish", detail: "A verification is queued or still running. Real results will appear here when the runner reports them.", href: "/verification", cta: "Refresh results" };
    if (openInvestigations.length > 0) { const top = openInvestigations[0]; return { title: "Review a confirmed issue", detail: `Start with "${top.title}". Review the evidence, then use the fix prompt or investigation details before rerunning verification.`, href: `#finding-${top.id}`, cta: "Review finding" }; }
    if (infraRecords.length > 0) return { title: "Fix the check setup and try again", detail: "Some checks could not run. These are setup or execution problems, not confirmed project issues. Review the blocked-check section below.", href: "#blocked-checks", cta: "See blocked checks" };
    if (latest?.outcome === "passed") return { title: "Run another check after changes", detail: "The latest recorded check passed for what it tested. If you changed the project, run verification again to gather fresh evidence.", href: "/verification", cta: "Run a test now" };
    return { title: "Run a verification check", detail: "No verification evidence has been recorded yet. Run a real check to see whether the project behaves as expected.", href: "/verification", cta: "Run a test now" };
  })();

  return (
    <div data-page="verification" className="space-y-6">
      <PageHeader
        title="Verification"
        subtitle="See real check results, confirmed project issues, and checks that could not run. Nothing here is a guess."
        actions={<RerunVerificationButton />}
      />

      <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className={`rounded-xl border p-5 md:p-6 shadow-soft ${toneClasses(latestPlain.tone)}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="k-label opacity-80 mb-2">Verification overview</div>
              <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">{latestPlain.label}</h2>
              <p className="mt-2 text-sm md:text-base opacity-90 max-w-3xl leading-relaxed">{latestPlain.detail}</p>
            </div>
            <StatusBadge status={latest?.outcome ?? "none"} />
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-white/10 bg-black/5 p-3"><div className="text-[11px] uppercase tracking-[0.12em] opacity-75">Project</div><div className="mt-1 text-sm font-medium text-fg">{latestProject.name}</div><div className="text-xs opacity-75 break-all">{latestProject.repo || latestProject.id}</div></div>
            <div className="rounded-lg border border-white/10 bg-black/5 p-3"><div className="text-[11px] uppercase tracking-[0.12em] opacity-75">When it ran</div><div className="mt-1 text-sm font-medium text-fg">{fmtDate(latest?.startedAt || latest?.finishedAt)}</div><div className="text-xs opacity-75">{fmtDuration(latest?.durationMs) ? `Duration ${fmtDuration(latest?.durationMs)}` : "Duration not recorded"}</div></div>
            <div className="rounded-lg border border-white/10 bg-black/5 p-3"><div className="text-[11px] uppercase tracking-[0.12em] opacity-75">Confirmed issues</div><div className="mt-1 text-xl font-semibold text-fg">{confirmedIssueCount}</div><div className="text-xs opacity-75">Open issues backed by evidence.</div></div>
            <div className="rounded-lg border border-white/10 bg-black/5 p-3"><div className="text-[11px] uppercase tracking-[0.12em] opacity-75">Checks could not run</div><div className="mt-1 text-xl font-semibold text-fg">{summary.blocked + incompleteRecords.length}</div><div className="text-xs opacity-75">Blocked, timed out, or still running.</div></div>
          </div>
          {latest ? <p className="mt-4 text-xs opacity-80">Latest recorded result: <span className="font-medium text-fg">{statusInfo(latest.outcome).label}</span>. {isInfraOutcome(latest.outcome) ? "This is an execution problem, not a confirmed project issue." : isIncomplete(latest.outcome) ? "This check is incomplete." : latest.outcome === "failed" ? "This indicates a genuine problem reported by the check." : "This check completed successfully for what it tested."}</p> : null}
        </div>

        <Panel title="Recommended next action" description="Based on the latest real verification data.">
          <div className="rounded-lg border border-accent/20 bg-accent-soft/10 p-4">
            <div className="k-label text-accent/80 mb-2">Recommended</div>
            <h3 className="text-base font-semibold text-fg">{nextAction.title}</h3>
            <p className="mt-2 text-sm text-muted leading-relaxed">{nextAction.detail}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {nextAction.href === "/verification" ? <RerunVerificationButton /> : <Link href={nextAction.href} className="inline-flex items-center px-4 py-2.5 rounded-md bg-accent text-black font-tech uppercase tracking-[0.12em] text-xs font-bold hover:brightness-110 shadow-glow">{nextAction.cta}</Link>}
            </div>
          </div>
          <div className="mt-4 space-y-2 text-xs text-muted">
            <div className="flex justify-between gap-3"><span>Runner status</span><span className={runnerHeartbeat.status === "connected" ? "text-emerald-300 font-medium" : "text-amber-300 font-medium"}>{runnerHeartbeat.status === "connected" ? "Connected" : "Not connected"}</span></div>
            <div className="flex justify-between gap-3"><span>Active/queued jobs</span><span className="text-fg font-medium">{activeJobs.length}</span></div>
            <div className="flex justify-between gap-3"><span>Latest project repository</span><span className="text-fg font-medium break-all text-right">{latestProject.repo || "Not assigned"}</span></div>
          </div>
          <details className="mt-4 text-xs text-muted"><summary className="cursor-pointer text-accent">Runner and execution details</summary><div className="mt-2 space-y-1 break-all"><div>Runner status: {runnerHeartbeat.status}</div>{"runnerId" in runnerHeartbeat && runnerHeartbeat.runnerId ? <div>Runner ID: <span className="font-mono">{runnerHeartbeat.runnerId}</span></div> : null}{"lastHeartbeat" in runnerHeartbeat && runnerHeartbeat.lastHeartbeat ? <div>Last heartbeat: {fmtDate(runnerHeartbeat.lastHeartbeat)}</div> : null}{"lastSuccessfulExecution" in runnerHeartbeat && runnerHeartbeat.lastSuccessfulExecution ? <div>Last successful execution: {fmtDate(runnerHeartbeat.lastSuccessfulExecution)}</div> : null}{runnerHeartbeat.note ? <div>Note: {runnerHeartbeat.note}</div> : null}</div></details>
        </Panel>
      </section>

      <Panel title="Verification history" description="Previous checks in chronological order. Each entry shows what happened and links to full details.">
        {allRecords.length === 0 ? (
          <EmptyState title="No verifications yet" detail="Run a real check to create verification history. Only genuine results will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead><tr className="text-left text-xs text-muted uppercase tracking-[0.12em] border-b border-border"><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Project</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Confirmed issues</th><th className="py-2 pr-3">Could not run</th><th className="py-2 pr-3">Result</th></tr></thead>
              <tbody className="divide-y divide-border">
                {allRecords.map((r) => {
                  const invs = investigationsForRecord(r, investigations);
                  const project = projectMeta.get(r.projectId || "") || { id: r.projectId || "default", name: r.projectId || "Default project", repo: null };
                  const plain = outcomePlain(r.outcome);
                  const infra = isInfraOutcome(r.outcome) || isIncomplete(r.outcome);
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="py-3 pr-3 text-fg/90 whitespace-nowrap">{fmtDate(r.startedAt)}{fmtDuration(r.durationMs) ? <div className="text-xs text-muted">{fmtDuration(r.durationMs)}</div> : null}</td>
                      <td className="py-3 pr-3"><div className="text-fg/90 font-medium">{project.name}</div><div className="text-xs text-muted break-all">{project.repo || project.id}</div></td>
                      <td className="py-3 pr-3"><StatusBadge status={r.outcome} /><div className="text-xs text-muted mt-1">{plain.label}</div></td>
                      <td className="py-3 pr-3"><span className={invs.filter(i => i.status === "open").length > 0 ? "text-rose-300 font-medium" : "text-muted"}>{invs.filter(i => i.status === "open").length}</span></td>
                      <td className="py-3 pr-3"><span className={infra ? "text-amber-300 font-medium" : "text-muted"}>{infra ? "Yes" : "No"}</span></td>
                      <td className="py-3 pr-3"><div className="text-xs text-muted max-w-[28rem] leading-relaxed">{r.summary || plain.detail}</div><a href={`#record-${r.id}`} className="text-xs text-accent underline mt-1 inline-block">View full result</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel title="Findings" description="Genuine issues reported by real checks. Infrastructure problems are listed separately below.">
          {openInvestigations.length === 0 ? (
            <EmptyState title="No confirmed project issues" detail={latest?.outcome === "failed" ? "A check failed, but no investigation record is available yet. Review the verification history for evidence." : "No open confirmed issues are recorded from real verification evidence."} />
          ) : (
            <div className="space-y-4">
              {openInvestigations.map((inv) => {
                const refs = inv.verificationReferences || [];
                const latestRef = refs[refs.length - 1];
                const linkedRecord = allRecords.find((r) => r.id === latestRef?.verificationId || (recordHasInvestigation(r, inv.id)));
                return (
                  <article key={inv.id} id={`finding-${inv.id}`} className="rounded-lg border border-rose-500/20 bg-rose-500/[0.03] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm md:text-base font-semibold text-fg">{inv.title}</h3>
                          <span className={`inline-flex items-center text-[11px] font-tech uppercase tracking-[0.12em] px-2 py-1 rounded border ${severityTone(inv.severity)}`}>{severityLabel(inv.severity)}</span>
                          <StatusBadge status={inv.status === "resolved" ? "completed" : "failed"} />
                        </div>
                        <p className="mt-2 text-sm text-muted leading-relaxed">{inv.simpleExplanation || "A genuine issue was detected by a real check."}</p>
                      </div>
                      <div className="text-xs text-muted shrink-0">Last seen: {fmtDate(inv.lastDetectedAt)}</div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
                      <div className="rounded border border-border bg-panel-2/20 p-3"><div className="text-muted uppercase tracking-[0.12em]">Why it matters</div><div className="mt-1 text-fg/90 leading-relaxed">{inv.actualBehaviour ? `What happened: ${inv.actualBehaviour}` : "This behavior was not confirmed to work as expected."}</div></div>
                      <div className="rounded border border-border bg-panel-2/20 p-3"><div className="text-muted uppercase tracking-[0.12em]">Affected area</div><div className="mt-1 text-fg/90 leading-relaxed">{inv.affectedAreas?.length ? inv.affectedAreas.join(", ") : "Not identified from available evidence."}</div></div>
                    </div>
                    <div className="mt-3 text-xs text-muted">Resolution status: <span className="text-fg font-medium">{inv.status === "open" ? "Open - needs attention" : inv.status === "resolved" ? "Resolved by subsequent evidence" : "Superseded"}</span></div>
                    {linkedRecord ? <a href={`#record-${linkedRecord.id}`} className="text-xs text-accent underline mt-2 inline-block">View related verification result</a> : null}
                    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer text-accent">Evidence and technical details</summary>
                      <div className="mt-2 space-y-3">
                        {latestRef ? <div className="rounded border border-border bg-black/10 p-3 space-y-1 break-all"><div>Verification ID: <span className="font-mono">{latestRef.verificationId}</span></div>{latestRef.jobId ? <div>Job ID: <span className="font-mono">{latestRef.jobId}</span></div> : null}<div>Outcome: {latestRef.outcome}</div>{latestRef.failingStep ? <div>Failing step: {latestRef.failingStep}</div> : null}{latestRef.evidencePath ? <div>Evidence path: <span className="font-mono">{latestRef.evidencePath}</span></div> : null}</div> : null}
                        {inv.expectedBehaviour ? <div><div className="text-muted mb-1">Expected behavior</div><div className="rounded border border-border bg-black/10 p-3 text-fg/85">{inv.expectedBehaviour}</div></div> : null}
                        {inv.technicalExplanation ? <div><div className="text-muted mb-1">Technical explanation</div><pre className="whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/85 overflow-x-auto">{inv.technicalExplanation}</pre></div> : null}
                        {inv.aiFixPrompt ? <div><div className="text-muted mb-1">Resolution prompt</div><pre className="whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/85 overflow-x-auto">{inv.aiFixPrompt}</pre></div> : null}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Checks that could not run" description="Setup or execution problems. These are not confirmed project issues.">
          {infraRecords.length === 0 && incompleteRecords.length === 0 ? (
            <EmptyState title="No blocked or incomplete checks" detail="All recorded checks either completed or there are no verification records yet." />
          ) : (
            <div className="space-y-3">
              {[...incompleteRecords, ...infraRecords].map((r) => {
                const project = projectMeta.get(r.projectId || "") || { id: r.projectId || "default", name: r.projectId || "Default project", repo: null };
                const cause = infraCause(r);
                return (
                  <div key={r.id} id={`blocked-${r.id}`} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-4">
                    <div className="flex flex-wrap items-center gap-2"><StatusBadge status={r.outcome} /><span className="text-sm font-medium text-fg">{project.name}</span><span className="text-xs text-muted">{fmtDate(r.startedAt)}</span></div>
                    <p className="mt-2 text-sm text-muted leading-relaxed">{cause.cause}</p>
                    <p className="mt-1 text-xs text-amber-200/90 leading-relaxed">Next step: {cause.next}</p>
                    <p className="mt-2 text-[11px] text-muted">This is an infrastructure/execution problem when evidence does not confirm an application issue. It is not a project vulnerability.</p>
                    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer text-accent">Technical details</summary><div className="mt-2 space-y-1 break-all">{r.jobId ? <div>Job ID: <span className="font-mono">{r.jobId}</span></div> : null}{typeof r.exitCode === "number" ? <div>Exit code: <span className="font-mono">{r.exitCode}</span></div> : null}{r.url ? <div>Target URL: <span className="font-mono">{r.url}</span></div> : null}{r.summary ? <div>Summary: {r.summary}</div> : null}{r.stderr ? <pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-black/10 p-2 text-muted overflow-x-auto">{r.stderr}</pre> : null}</div></details>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </section>

      <Panel title="Full verification results" description="Expandable technical details for every recorded check. Evidence and IDs are preserved.">
        {allRecords.length === 0 ? (
          <EmptyState title="No results to show" detail="When checks run, their full results and technical evidence will appear here." />
        ) : (
          <div className="space-y-3">
            {allRecords.map((r) => {
              const invs = investigationsForRecord(r, investigations);
              const project = projectMeta.get(r.projectId || "") || { id: r.projectId || "default", name: r.projectId || "Default project", repo: null };
              const plain = outcomePlain(r.outcome);
              return (
                <article key={r.id} id={`record-${r.id}`} className="rounded-lg border border-border bg-panel-2/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={r.outcome} /><span className="text-sm font-medium text-fg">{r.flow === "shell-nav" ? "Main pages check" : r.flow}</span><span className="text-xs text-muted">{project.name}</span></div>
                      <p className="mt-1 text-xs text-muted">{plain.label} — {plain.detail}</p>
                    </div>
                    <div className="text-xs text-muted text-right"><div>{fmtDate(r.startedAt)}</div>{fmtDuration(r.durationMs) ? <div>{fmtDuration(r.durationMs)}</div> : null}</div>
                  </div>
                  <div className="mt-2 text-sm text-fg/90">{r.summary || "No summary available."}</div>
                  {r.failingStep ? <div className="mt-2 text-sm text-rose-300"><strong>Where it went wrong:</strong> {r.failingStep}</div> : null}
                  {invs.length > 0 ? <div className="mt-2 text-xs text-muted">Related findings: {invs.map((i) => <a key={i.id} href={`#finding-${i.id}`} className="text-accent underline mr-2">{i.title}</a>)}</div> : null}
                  <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer text-accent">Technical details</summary>
                    <div className="mt-2 grid gap-1 break-all">
                      <div>Record ID: <span className="font-mono">{r.id}</span></div>
                      {r.jobId ? <div>Job ID: <span className="font-mono">{r.jobId}</span></div> : null}
                      {r.projectId ? <div>Project ID: <span className="font-mono">{r.projectId}</span></div> : null}
                      {r.url ? <div>Target URL: <span className="font-mono">{r.url}</span></div> : null}
                      {typeof r.exitCode === "number" ? <div>Exit code: <span className="font-mono">{r.exitCode}</span></div> : null}
                      {typeof r.creditsConsumed === "number" ? <div>Credits consumed: {r.creditsConsumed}</div> : null}
                      {r.command ? <div>Command: <span className="font-mono">{r.command}</span></div> : null}
                      {r.testUrl ? <div>Test report: <a className="text-accent underline" href={r.testUrl} target="_blank" rel="noreferrer">Open report</a></div> : null}
                      {r.evidencePath ? <div>Evidence path: <span className="font-mono">{r.evidencePath}</span></div> : null}
                      {r.sessionDir ? <div>Session dir: <span className="font-mono">{r.sessionDir}</span></div> : null}
                      <div>NDJSON log: <span className="font-mono">{r.ndjsonPath || `data/verification/runs/${r.id}.ndjson`}</span></div>
                      {r.runEnd ? <div>Recorded run_end status: <span className="font-mono">{String(r.runEnd.status || r.outcome)}</span></div> : null}
                      {r.finishedAt ? <div>Finished: {fmtDate(r.finishedAt)}</div> : null}
                      {r.investigationProcessing ? <div>Investigation processing: <span className="font-mono">{r.investigationProcessing.state}</span>{r.investigationProcessing.error ? ` — ${r.investigationProcessing.error}` : ""}</div> : null}
                    </div>
                    {r.stderr ? <div className="mt-2"><div className="mb-1">Diagnostic output</div><pre className="whitespace-pre-wrap rounded border border-border bg-black/10 p-2 text-muted overflow-x-auto">{r.stderr}</pre></div> : null}
                    {r.runEnd ? <details className="mt-2"><summary className="cursor-pointer text-accent">Raw run_end payload</summary><pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-black/10 p-2 text-muted overflow-x-auto">{JSON.stringify(r.runEnd, null, 2)}</pre></details> : null}
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function recordHasInvestigation(r: VerificationRecord, invId: string): boolean {
  return !!r.investigationIds?.includes(invId);
}
