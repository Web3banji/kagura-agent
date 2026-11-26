import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { readStories } from "@/lib/stories/store";
import { readInvestigations } from "@/lib/investigations/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { resolveProjectIdsForUser } from "@/lib/verification/context";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import type { Story } from "@/types/story";
import type { Investigation } from "@/types/investigation";
import type { VerificationRecord } from "@/types/verification";

type ReportStatus = "published" | "attention";

function fmtDate(value?: string | null): string {
  if (!value) return "Unknown date";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString();
}

async function resolveProjectNames(projectIds: string[], userId: string | undefined): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of projectIds) map.set(id, id);
  if (!hasDatabase() || !userId || projectIds.length === 0) return map;
  try {
    await ensureDb();
    const res = await getPool().query(`SELECT id, name FROM projects WHERE owner_user_id = $1 AND id = ANY($2::text[])`, [userId, projectIds]);
    for (const row of res.rows as Array<{ id: string; name: string }>) map.set(String(row.id), String(row.name || row.id));
  } catch {}
  return map;
}

function reportType(s: Story): string {
  if (s.verification?.flow) return `Verification report (${s.verification.flow})`;
  if (s.verification) return "Verification report";
  return "Project report";
}

function outcomeLabel(outcome?: string): string {
  if (!outcome) return "No verification attached";
  if (outcome === "passed") return "Check completed successfully";
  if (outcome === "failed") return "Check reported a problem";
  if (outcome === "blocked" || outcome === "did_not_start") return "Check blocked / could not start";
  if (outcome === "timeout") return "Check incomplete (timeout)";
  if (outcome === "pending" || outcome === "running") return "Check in progress";
  return outcome.replace(/_/g, " ");
}

function reportNeedsAttention(s: Story): boolean {
  const o = s.verification?.outcome;
  return o === "failed" || o === "blocked" || o === "did_not_start" || o === "timeout";
}

function reportStatus(s: Story): ReportStatus {
  return reportNeedsAttention(s) ? "attention" : "published";
}

function normalize(v: string | string[] | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export default async function ReportsSection({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) || {};
  const q = normalize(sp.q).toLowerCase();
  const typeFilter = normalize(sp.type) || "all";
  const projectFilter = normalize(sp.project) || "all";
  const statusFilter = normalize(sp.status) || "all";
  const sort = normalize(sp.sort) || "newest";
  const selectedId = normalize(sp.report);

  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal);
  const allowLegacy = !principal.userId || principalHasLegacyAccess(principal);
  const visibleProjectIds = principal.userId ? await resolveProjectIdsForUser(principal.userId) : [];

  const [stories, investigations, verification] = await Promise.all([
    readStories(scope).catch(() => [] as Story[]),
    readInvestigations(scope).catch(() => [] as Investigation[]),
    readVerificationRecords({ requestedBy: principal.userId ?? undefined, includeLegacy: allowLegacy }).catch(() => [] as VerificationRecord[]),
  ]);

  const reports = stories
    .filter((s) => s.status === "published")
    .filter((s) => {
      const pid = (s as Story & { projectId?: string }).projectId;
      return !pid || visibleProjectIds.includes(pid);
    })
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt).getTime() - new Date(a.publishedAt || a.updatedAt).getTime());

  const scopedInvestigations = investigations.filter((i) => !i.projectId || visibleProjectIds.includes(i.projectId));
  const scopedVerification = verification.filter((r) => (r.projectId ? visibleProjectIds.includes(r.projectId) : allowLegacy));

  const projectIds = Array.from(new Set([
    ...reports.map((s) => (s as Story & { projectId?: string }).projectId).filter((v): v is string => !!v),
    ...scopedInvestigations.map((i) => i.projectId).filter((v): v is string => !!v),
    ...scopedVerification.map((r) => r.projectId).filter((v): v is string => !!v),
  ]));
  const projectNames = await resolveProjectNames(projectIds, principal.userId);

  const verificationById = new Map(scopedVerification.map((r) => [r.id, r]));
  const investigationsByVerification = new Map<string, Investigation[]>();
  for (const inv of scopedInvestigations) {
    for (const ref of inv.verificationReferences || []) {
      const arr = investigationsByVerification.get(ref.verificationId) || [];
      arr.push(inv);
      investigationsByVerification.set(ref.verificationId, arr);
    }
  }

  const types = Array.from(new Set(reports.map(reportType))).sort();
  const projectOptions = Array.from(new Set(reports.map((s) => (s as Story & { projectId?: string }).projectId).filter((v): v is string => !!v)))
    .map((id) => ({ id, name: projectNames.get(id) || id }));

  const filtered = reports.filter((s) => {
    const pid = (s as Story & { projectId?: string }).projectId;
    const pName = pid ? projectNames.get(pid) || pid : "";
    const rType = reportType(s);
    const status = reportStatus(s);
    if (typeFilter !== "all" && rType !== typeFilter) return false;
    if (projectFilter !== "all" && pid !== projectFilter) return false;
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (q) {
      const hay = [s.title, s.subtitle, s.body, rType, pName, outcomeLabel(s.verification?.outcome), s.slug, s.id].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sort === "oldest") return new Date(a.publishedAt || a.updatedAt).getTime() - new Date(b.publishedAt || b.updatedAt).getTime();
    if (sort === "title") return a.title.localeCompare(b.title);
    return new Date(b.publishedAt || b.updatedAt).getTime() - new Date(a.publishedAt || a.updatedAt).getTime();
  });

  const selected = filtered.find((s) => s.id === selectedId || s.slug === selectedId) || filtered[0] || reports[0];
  const selectedVerificationSnapshot = selected?.verification;
  const selectedCurrentVerification = selectedVerificationSnapshot?.id ? verificationById.get(selectedVerificationSnapshot.id) : undefined;
  const selectedInvestigations = selectedCurrentVerification ? (investigationsByVerification.get(selectedCurrentVerification.id) || []) : [];
  const selectedProjectId = selected ? (selected as Story & { projectId?: string }).projectId : undefined;
  const selectedProjectName = selectedProjectId ? projectNames.get(selectedProjectId) || selectedProjectId : "No project linked";

  const latest = reports[0];
  const attentionCount = reports.filter(reportNeedsAttention).length;
  const typeCounts = types.map((t) => ({ type: t, count: reports.filter((r) => reportType(r) === t).length }));

  function buildHref(next: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const merged = { q: q || undefined, type: typeFilter !== "all" ? typeFilter : undefined, project: projectFilter !== "all" ? projectFilter : undefined, status: statusFilter !== "all" ? statusFilter : undefined, sort: sort !== "newest" ? sort : undefined, report: selected?.id, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const qs = params.toString();
    return qs ? `/reports?${qs}` : "/reports";
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="REPORTS"
        title="Reports"
        subtitle="Published reports generated from real project activity and verification evidence. Reports distinguish completed checks, genuine issues, and blocked or incomplete checks."
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Available reports</div><div className="mt-2 text-2xl font-semibold text-fg">{reports.length}</div><div className="mt-1 text-xs text-muted">Published report records currently available.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Most recent report</div><div className="mt-2 text-sm font-semibold text-fg">{latest ? latest.title : "No reports yet"}</div><div className="mt-1 text-xs text-muted">{latest ? fmtDate(latest.publishedAt || latest.updatedAt) : "A report will appear after publishing."}</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Needs attention</div><div className="mt-2 text-2xl font-semibold text-fg">{attentionCount}</div><div className="mt-1 text-xs text-muted">Published reports whose attached verification reported failure, block, or incomplete execution.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Report types</div><div className="mt-2 text-sm font-semibold text-fg">{typeCounts.length ? typeCounts.map((t) => `${t.type}: ${t.count}`).join(" Â· ") : "None"}</div><div className="mt-1 text-xs text-muted">Counts from existing persisted report metadata.</div></Panel>
      </section>

      <Panel title="Reports library" description="Search and filter real published reports. Open a report for details, source references, and existing actions.">
        <form action="/reports" method="get" className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_0.8fr_auto] mb-4">
          <label className="block"><div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Search</div><input name="q" defaultValue={q} placeholder="Title, project, summary, outcome" className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg" /></label>
          <label className="block"><div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Type</div><select name="type" defaultValue={typeFilter} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg"><option value="all">All types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          <label className="block"><div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Project</div><select name="project" defaultValue={projectFilter} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg"><option value="all">All projects</option>{projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block"><div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Status</div><select name="status" defaultValue={statusFilter} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg"><option value="all">All statuses</option><option value="published">Published</option><option value="attention">Needs attention</option></select></label>
          <label className="block"><div className="mb-1 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Sort</div><select name="sort" defaultValue={sort} className="w-full rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="title">Title</option></select></label>
          <div className="flex items-end gap-2"><button type="submit" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-sm text-fg hover:border-accent/40">Apply</button><Link href="/reports" className="rounded-lg border border-border bg-bg/10 px-3 py-2 text-sm text-muted hover:text-fg">Clear</Link></div>
        </form>

        {reports.length === 0 ? (
          <EmptyState title="No published reports yet" detail="Published report records will appear here after they are generated from real project activity and verification evidence. If no report has been published, there is no report to show here." />
        ) : filtered.length === 0 ? (
          <EmptyState title="No reports match these filters" detail="Try a different search, type, project, or status filter. Only real persisted reports are shown." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
            <div className="overflow-x-auto rounded-xl border border-border bg-bg/15">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-bg/30 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-3 py-3">Report</th>
                    <th className="px-3 py-3">Project</th>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const pid = (s as Story & { projectId?: string }).projectId;
                    const projectName = pid ? projectNames.get(pid) || pid : "No project linked";
                    const active = selected?.id === s.id;
                    const attention = reportNeedsAttention(s);
                    return (
                      <tr key={s.id} className={`border-t border-border/70 ${active ? "bg-accent/5" : ""}`}>
                        <td className="px-3 py-3 align-top">
                          <div className="font-medium text-fg">{s.title}</div>
                          <div className="mt-1 text-xs text-muted">{reportType(s)} Â· {outcomeLabel(s.verification?.outcome)}</div>
                          <div className="mt-1 text-xs text-muted line-clamp-2">{s.subtitle || s.source.observationSummary}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-muted">{projectName}</td>
                        <td className="px-3 py-3 align-top text-xs text-muted">{fmtDate(s.publishedAt || s.updatedAt)}</td>
                        <td className="px-3 py-3 align-top"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${attention ? "border-amber-500/25 bg-amber-500/10 text-amber-300" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"}`}>{attention ? "Needs attention" : "Published"}</span></td>
                        <td className="px-3 py-3 align-top"><Link href={buildHref({ report: s.id })} className="text-xs text-accent underline">Open</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-4">
              {selected ? (
                <article className="rounded-xl border border-border bg-bg/20 p-4 space-y-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${reportNeedsAttention(selected) ? "border-amber-500/25 bg-amber-500/10 text-amber-300" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"}`}>{reportNeedsAttention(selected) ? "Needs attention" : "Published"}</span>
                        <span className="rounded-full border border-border bg-bg/30 px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] text-muted">{reportType(selected)}</span>
                      </div>
                      <h2 className="mt-2 text-lg font-semibold text-fg">{selected.title}</h2>
                      <p className="mt-1 text-sm text-muted">{selected.subtitle || "No subtitle recorded."}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {selected.verification?.testUrl ? <a href={selected.verification.testUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-fg hover:border-accent/40">External test report</a> : null}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Project</div><div className="mt-1 text-sm text-fg">{selectedProjectName}</div></div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Generated / published</div><div className="mt-1 text-sm text-fg">{fmtDate(selected.publishedAt || selected.updatedAt)}</div></div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Published verification snapshot</div><div className="mt-1 text-sm text-fg">{selectedVerificationSnapshot ? `${outcomeLabel(selectedVerificationSnapshot.outcome)}${selected.publishedAt ? ` · published ${fmtDate(selected.publishedAt)}` : ""}` : "No verification snapshot stored"}</div><div className="mt-1 text-[11px] text-muted">Historical publication snapshot; not rewritten by later checks.</div></div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Current linked verification</div><div className="mt-1 text-sm text-fg">{selectedCurrentVerification ? `${outcomeLabel(selectedCurrentVerification.outcome)}${selectedCurrentVerification.finishedAt ? ` · ${fmtDate(selectedCurrentVerification.finishedAt)}` : ""}` : "Current record unavailable in this scope"}</div><div className="mt-1 text-[11px] text-muted">Current status shown separately and may differ from publication.</div></div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Source</div><div className="mt-1 text-sm text-fg">{selected.source.repo || "Repository not recorded"}{selected.source.observationSource ? ` Â· ${selected.source.observationSource}` : ""}</div></div>
                  </div>

                  <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                    <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Executive summary</div>
                    <div className="mt-2 text-sm text-muted whitespace-pre-wrap">{selected.source.observationSummary || selected.subtitle || "No summary recorded."}</div>
                    {selected.verification ? (
                      <div className="mt-3 text-xs text-muted">
                        Verification outcome: <span className="text-fg/90">{outcomeLabel(selected.verification.outcome)}</span>.
                        {selected.verification.outcome === "failed" ? " This indicates a real check reported a problem." : ""}
                        {selected.verification.outcome === "blocked" || selected.verification.outcome === "did_not_start" ? " This is an execution/setup limitation, not a project pass/fail or vulnerability." : ""}
                        {selected.verification.outcome === "timeout" ? " This check is incomplete, not a pass/fail." : ""}
                      </div>
                    ) : <div className="mt-3 text-xs text-muted">No verification was attached to this report; treat claims as observation-based, not verification-confirmed.</div>}
                  </div>

                  <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                    <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Confirmed findings / checks</div>
                    <div className="mt-2 space-y-2 text-sm text-muted">
                      {selectedInvestigations.length > 0 ? selectedInvestigations.map((inv) => (
                        <div key={inv.id} className="rounded-md border border-border/60 bg-bg/20 p-2">
                          <div className="text-fg/90 font-medium">{inv.title}</div>
                          <div className="text-xs text-muted mt-1">{inv.simpleExplanation || inv.technicalExplanation}</div>
                          <div className="text-xs text-muted mt-1">Status: {inv.status} Â· Severity: {inv.severity || "not set"}</div>
                        </div>
                      )) : selected.verification?.outcome === "failed" ? (
                        <div>Verification reported a problem, but no linked investigation record was found in scoped records.</div>
                      ) : (
                        <div>No confirmed investigation findings are linked to this report.</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                    <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Blocked / incomplete checks and limits</div>
                    <div className="mt-2 text-sm text-muted">
                      {selected.verification?.outcome === "blocked" || selected.verification?.outcome === "did_not_start" || selected.verification?.outcome === "timeout"
                        ? `Attached verification is ${outcomeLabel(selected.verification.outcome)}. Do not treat this as a project pass/fail assessment.`
                        : "No blocked/incomplete attached verification is recorded for this report."}
                    </div>
                  </div>

                  <details className="rounded-lg border border-border/70 bg-bg/10 p-3">
                    <summary className="cursor-pointer text-xs font-medium text-fg/90">Evidence, references, and generation metadata</summary>
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Report ID</dt><dd className="text-fg/90 break-all">{selected.id}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Slug</dt><dd className="text-fg/90 break-all">{selected.slug}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Project ID</dt><dd className="text-fg/90 break-all">{selectedProjectId || "Not linked"}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Created</dt><dd className="text-fg/90">{fmtDate(selected.createdAt)}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Updated</dt><dd className="text-fg/90">{fmtDate(selected.updatedAt)}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Published</dt><dd className="text-fg/90">{fmtDate(selected.publishedAt)}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Generation source</dt><dd className="text-fg/90">{selected.generationSource || "Not recorded"}</dd></div>
                      <div><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Commits referenced</dt><dd className="text-fg/90">{selected.source.commits.length}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Changed files</dt><dd className="text-fg/90 break-words">{selected.source.changedFiles?.length ? selected.source.changedFiles.join(", ") : "None recorded"}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Verification reference</dt><dd className="text-fg/90 break-words">{selected.verification ? `${selected.verification.id} Â· ${selected.verification.outcome}${selected.verification.failingStep ? ` Â· ${selected.verification.failingStep}` : ""}` : "No verification attached"}</dd></div>
                      {selectedCurrentVerification?.evidencePath ? <div className="sm:col-span-2"><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Evidence path</dt><dd className="text-fg/90 break-all">{selectedCurrentVerification.evidencePath}</dd></div> : null}
                      {selectedCurrentVerification?.ndjsonPath ? <div className="sm:col-span-2"><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">NDJSON path</dt><dd className="text-fg/90 break-all">{selectedCurrentVerification.ndjsonPath}</dd></div> : null}
                      {selectedInvestigations.length ? <div className="sm:col-span-2"><dt className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Linked investigations</dt><dd className="text-fg/90 break-words">{selectedInvestigations.map((i) => `${i.id} (${i.status})`).join(" | ")}</dd></div> : null}
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      <Link href="/verification" className="text-accent underline">Open Verification</Link>
                    </div>
                  </details>
                </article>
              ) : (
                <EmptyState title="No report selected" detail="Select a report from the library to view details." />
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Report generation" description="Report generation uses existing published report records and verification evidence. This page does not create fake reports or synthetic success states.">
        <div className="text-sm text-muted space-y-2">
          <p>Reports are generated from real project activity and verification evidence. Published report records appear here without inventing report content.</p>
          <p>If required source data is missing, Verification will show the missing/blocked state; Reports will not invent report content.</p>
        </div>
      </Panel>
    </div>
  );
}