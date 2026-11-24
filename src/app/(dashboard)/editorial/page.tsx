import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readStories } from "@/lib/stories/store";
import { readInvestigations } from "@/lib/investigations/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { readRuns } from "@/lib/agent/runs";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { resolveProjectIdsForUser } from "@/lib/verification/context";
import { aiConfigured } from "@/lib/ai/provider";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import type { Investigation } from "@/types/investigation";
import type { Story } from "@/types/story";
import type { VerificationRecord } from "@/types/verification";
import type { AgentRun } from "@/types/run";
import { DraftActions } from "./draft-actions";

export const dynamic = "force-dynamic";

function fmtDate(value?: string | null): string {
  if (!value) return "Unknown time";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown time";
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

function discoveryKind(inv: Investigation, linked: VerificationRecord | undefined): { label: string; tone: string; description: string } {
  const latest = inv.verificationReferences[inv.verificationReferences.length - 1];
  const outcome = latest?.outcome || linked?.outcome;
  if (inv.status === "resolved") return { label: "Resolved", tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300", description: "A later real check confirmed this specific issue is resolved." };
  if (outcome === "blocked" || outcome === "did_not_start" || outcome === "timeout") {
    return { label: "Blocked / incomplete check", tone: "border-amber-500/25 bg-amber-500/10 text-amber-300", description: "A check could not start or finish. This is an execution/infrastructure limitation, not a confirmed project vulnerability." };
  }
  if (outcome === "failed") {
    return { label: "Confirmed finding", tone: "border-rose-500/25 bg-rose-500/10 text-rose-300", description: "A real verification reported a failure with evidence." };
  }
  if (inv.status === "open") return { label: "Observation / investigation", tone: "border-sky-500/25 bg-sky-500/10 text-sky-300", description: "Recorded from real evidence, but treat as an investigation unless a real check confirms it." };
  return { label: "Historical information", tone: "border-slate-400/25 bg-slate-400/10 text-slate-300", description: "Historical record from persisted project data." };
}

function resolutionStatus(inv: Investigation): { label: string; detail: string } {
  if (inv.status === "resolved") return { label: "Resolved by evidence", detail: "Resolved only after a real subsequent verification confirmed the specific issue was fixed." };
  if (inv.status === "superseded") return { label: "Superseded", detail: "This investigation was replaced by newer information." };
  return { label: "Open - needs evidence", detail: "Open until a real subsequent verification confirms the fix. A generated prompt or code change claim alone does not resolve it." };
}

function nextActionForInvestigation(inv: Investigation, linked: VerificationRecord | undefined): { label: string; href: string; detail: string } {
  const latestOutcome = inv.verificationReferences[inv.verificationReferences.length - 1]?.outcome || linked?.outcome;
  if (inv.status === "resolved") return { label: "No action needed", href: "/verification", detail: "This specific issue has evidence-backed resolution." };
  if (latestOutcome === "blocked" || latestOutcome === "did_not_start" || latestOutcome === "timeout") {
    return { label: "Inspect blocked check", href: "/verification", detail: "The check could not complete. Fix execution/setup issues before treating it as a project finding." };
  }
  if (inv.aiFixPrompt) return { label: "Use resolution prompt", href: "#resolution-guidance", detail: "Use the actionable prompt with your coding agent, then run a real verification to confirm the fix." };
  return { label: "Review evidence", href: "/verification", detail: "Review the investigation and linked verification evidence before taking action." };
}

function storyBucket(s: Story): "draft" | "review" | "published" | "rejected" {
  if (s.status === "published") return "published";
  if (s.status === "review") return "review";
  if (s.status === "rejected") return "rejected";
  return "draft";
}


export default async function IntelligencePage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal);
  const allowLegacy = !principal.userId || principalHasLegacyAccess(principal);
  const visibleProjectIds = principal.userId ? await resolveProjectIdsForUser(principal.userId) : [];

  const [stories, investigations, verification, runs] = await Promise.all([
    readStories(scope).catch(() => [] as Story[]),
    readInvestigations(scope).catch(() => [] as Investigation[]),
    readVerificationRecords({ requestedBy: principal.userId ?? undefined, includeLegacy: allowLegacy }).catch(() => [] as VerificationRecord[]),
    readRuns(scope).catch(() => [] as AgentRun[]),
  ]);

  const scopedInvestigations = investigations
    .filter((i) => !i.projectId || visibleProjectIds.includes(i.projectId))
    .sort((a, b) => new Date(b.lastDetectedAt || b.updatedAt).getTime() - new Date(a.lastDetectedAt || a.updatedAt).getTime());
  const scopedStories = stories
    .filter((s) => {
      const projectId = (s as Story & { projectId?: string }).projectId;
      return !projectId || visibleProjectIds.includes(projectId);
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  const scopedVerification = verification.filter((r) => (r.projectId ? visibleProjectIds.includes(r.projectId) : allowLegacy));

  const projectIds = Array.from(new Set([
    ...scopedInvestigations.map((i) => i.projectId).filter((v): v is string => !!v),
    ...scopedStories.map((s) => (s as Story & { projectId?: string }).projectId).filter((v): v is string => !!v),
    ...scopedVerification.map((r) => r.projectId).filter((v): v is string => !!v),
  ]));
  const projectNames = await resolveProjectNames(projectIds, principal.userId);

  const verificationById = new Map(scopedVerification.map((r) => [r.id, r]));
  const linkedForInvestigation = (inv: Investigation) => {
    for (let i = inv.verificationReferences.length - 1; i >= 0; i--) {
      const ref = inv.verificationReferences[i];
      const rec = verificationById.get(ref.verificationId);
      if (rec) return rec;
    }
    return undefined;
  };

  const drafts = scopedStories.filter((s) => storyBucket(s) === "draft");
  const ready = scopedStories.filter((s) => storyBucket(s) === "review");
  const published = scopedStories.filter((s) => storyBucket(s) === "published");
  const rejected = scopedStories.filter((s) => storyBucket(s) === "rejected");
  const openDiscoveries = scopedInvestigations.filter((i) => i.status === "open");
  const awaitingDecision = ready.length + openDiscoveries.length;
  const latestUpdate = [
    ...scopedInvestigations.map((i) => i.lastDetectedAt || i.updatedAt),
    ...scopedStories.map((s) => s.updatedAt || s.createdAt),
    ...scopedVerification.map((r) => r.finishedAt || r.startedAt),
  ].filter(Boolean).sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0];

  const ai = aiConfigured();
  const latestRun = runs[0];
  const primaryDiscovery = openDiscoveries[0] || scopedInvestigations[0];
  const primaryStory = ready[0] || drafts[0] || published[0];
  const primaryNext = primaryDiscovery
    ? nextActionForInvestigation(primaryDiscovery, linkedForInvestigation(primaryDiscovery))
    : primaryStory
      ? { label: primaryStory.status === "published" ? "No action needed" : primaryStory.status === "review" ? "Review draft" : "Continue draft", href: "#intelligence-content", detail: primaryStory.status === "published" ? "Published intelligence is available in Reports." : "Review or continue this draft before publishing." }
      : { label: "No action needed", href: "/command-center", detail: "There is no intelligence item requiring attention right now." };

  return (
    <div className="space-y-6" data-page="editorial">
      <PageHeader
        eyebrow="INTELLIGENCE"
        title="Intelligence"
        subtitle="Understand what KAGURA has learned from real project evidence, decide what to do next, and turn verified findings into clear content."
        actions={<StatusBadge status={ai.configured ? "success" : "idle"} />}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Latest update</div><div className="mt-2 text-sm font-semibold text-fg">{latestUpdate ? fmtDate(latestUpdate) : "No updates yet"}</div><div className="mt-1 text-xs text-muted">Most recent persisted intelligence, verification, or content update.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Open discoveries</div><div className="mt-2 text-2xl font-semibold text-fg">{openDiscoveries.length}</div><div className="mt-1 text-xs text-muted">Investigations still open and requiring attention or evidence.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Drafts available</div><div className="mt-2 text-2xl font-semibold text-fg">{drafts.length + ready.length}</div><div className="mt-1 text-xs text-muted">Draft and review content from real records.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Published intelligence</div><div className="mt-2 text-2xl font-semibold text-fg">{published.length}</div><div className="mt-1 text-xs text-muted">Published stories already available in Reports/Stories.</div></Panel>
        <Panel><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Awaiting decision</div><div className="mt-2 text-2xl font-semibold text-fg">{awaitingDecision}</div><div className="mt-1 text-xs text-muted">Open discoveries or drafts waiting for developer review.</div></Panel>
      </section>


      <Panel title="Recommended next action" description="Context-sensitive action based on real persisted intelligence records.">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-sm font-medium text-fg">{primaryNext.label}</div>
            <div className="mt-1 text-sm text-muted">{primaryNext.detail}</div>
            {latestRun && <div className="mt-2 text-xs text-muted">Latest agent run: {latestRun.status} ({fmtDate(latestRun.finishedAt || latestRun.startedAt)}).</div>}
          </div>
          <Link href={primaryNext.href} className="inline-flex rounded-lg border border-border bg-bg/30 px-3 py-2 text-xs text-fg hover:border-accent/40">{primaryNext.label === "No action needed" ? "View status" : "Open"}</Link>
        </div>
      </Panel>

      <Panel title="Project intelligence" description="Genuine discoveries from persisted investigations and linked verification evidence. No fabricated insights or scores.">
        {scopedInvestigations.length === 0 ? (
          <EmptyState title="No project intelligence yet" detail="When KAGURA records investigations from real verification evidence, they will appear here with explanations, evidence, and next actions." />
        ) : (
          <div className="space-y-4">
            {scopedInvestigations.map((inv) => {
              const linked = linkedForInvestigation(inv);
              const kind = discoveryKind(inv, linked);
              const resolution = resolutionStatus(inv);
              const next = nextActionForInvestigation(inv, linked);
              const projectName = inv.projectId ? projectNames.get(inv.projectId) || inv.projectId : "Project not specified";
              const latestRef = inv.verificationReferences[inv.verificationReferences.length - 1];
              return (
                <article key={inv.id} className="rounded-xl border border-border bg-bg/20 p-4 space-y-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] ${kind.tone}`}>{kind.label}</span>
                        <span className="rounded-full border border-border bg-bg/30 px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.12em] text-muted">{resolution.label}</span>
                        <span className="text-xs text-muted">Project: <span className="text-fg/85">{projectName}</span></span>
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-fg">{inv.title}</h3>
                        <p className="mt-1 text-sm text-muted">{inv.simpleExplanation || inv.technicalExplanation}</p>
                      </div>
                      <div className="text-xs text-muted">{kind.description}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href="/verification" className="rounded-lg border border-border bg-bg/30 px-3 py-2 text-xs text-fg hover:border-accent/40">Open verification</Link>
                      {latestRef?.evidencePath ? <span className="rounded-lg border border-border bg-bg/10 px-3 py-2 text-xs text-muted">Evidence linked</span> : null}
                    </div>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-3">
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                      <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Why it matters</div>
                      <div className="mt-2 text-sm text-fg/90">{inv.actualBehaviour || inv.rootCause || "This item may affect project behavior or confidence. Review evidence before acting."}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                      <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Evidence / confidence</div>
                      <div className="mt-2 text-sm text-fg/90">
                        {latestRef ? `Latest linked verification: ${latestRef.outcome}${latestRef.failingStep ? ` (${latestRef.failingStep})` : ""}.` : "No linked verification reference recorded."}
                      </div>
                      <div className="mt-1 text-xs text-muted">Confidence is limited to recorded evidence. Missing verification is not proof of safety.</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-bg/15 p-3">
                      <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Recommended next action</div>
                      <div className="mt-2 text-sm text-fg/90">{next.label}</div>
                      <div className="mt-1 text-xs text-muted">{next.detail}</div>
                    </div>
                  </div>

                  <details id={primaryDiscovery?.id === inv.id ? "resolution-guidance" : undefined} className="rounded-lg border border-border/70 bg-bg/10 p-3">
                    <summary className="cursor-pointer text-xs font-medium text-fg/90">Explanations, resolution guidance, and technical evidence</summary>
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                          <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Plain-language explanation</div>
                          <div className="mt-2 text-sm text-fg/90 whitespace-pre-wrap">{inv.simpleExplanation || "No plain-language explanation recorded."}</div>
                        </div>
                        <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                          <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Technical explanation</div>
                          <div className="mt-2 text-sm text-fg/90 whitespace-pre-wrap">{inv.technicalExplanation || "No technical explanation recorded."}</div>
                        </div>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                          <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Why it matters / expected vs actual</div>
                          <div className="mt-2 text-xs text-muted space-y-1">
                            <div><span className="text-fg/80">Expected:</span> {inv.expectedBehaviour || "Not recorded."}</div>
                            <div><span className="text-fg/80">Actual:</span> {inv.actualBehaviour || "Not recorded."}</div>
                            <div><span className="text-fg/80">Root cause:</span> {inv.rootCause || "Not confirmed."}</div>
                          </div>
                        </div>
                        <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                          <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Resolution status</div>
                          <div className="mt-2 text-sm text-fg/90">{resolution.label}</div>
                          <div className="mt-1 text-xs text-muted">{resolution.detail}</div>
                          {latestRef && (
                            <div className="mt-2 text-xs text-muted">Latest linked verification: {latestRef.outcome} at {fmtDate(latestRef.detectedAt)}{latestRef.verificationId ? ` (${latestRef.verificationId.slice(0, 8)})` : ""}.</div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                        <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Actionable resolution prompt</div>
                        {inv.aiFixPrompt ? (
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/30 p-3 text-[11px] text-muted">{inv.aiFixPrompt}</pre>
                        ) : (
                          <div className="mt-2 text-sm text-muted">No resolution prompt has been recorded for this investigation.</div>
                        )}
                        <div className="mt-2 text-xs text-amber-300/90">Using or generating a prompt does not resolve the issue. Resolution requires a real subsequent verification confirming the specific fix.</div>
                      </div>

                      <div className="rounded-md border border-border/60 bg-bg/20 p-3">
                        <div className="text-[10px] font-tech uppercase tracking-[0.12em] text-muted">Technical evidence</div>
                        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Investigation ID</dt><dd className="text-xs text-fg/90 break-all">{inv.id}</dd></div>
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Status</dt><dd className="text-xs text-fg/90">{inv.status}</dd></div>
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Project ID</dt><dd className="text-xs text-fg/90 break-all">{inv.projectId || "Not specified"}</dd></div>
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Repository connection</dt><dd className="text-xs text-fg/90 break-all">{inv.repositoryConnectionId || "Not specified"}</dd></div>
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">First detected</dt><dd className="text-xs text-fg/90">{fmtDate(inv.firstDetectedAt)}</dd></div>
                          <div><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Last detected</dt><dd className="text-xs text-fg/90">{fmtDate(inv.lastDetectedAt)}</dd></div>
                          <div className="sm:col-span-2"><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Verification references</dt><dd className="text-xs text-fg/90 break-words">{inv.verificationReferences.length ? inv.verificationReferences.map((r) => `${r.outcome} ${r.verificationId}${r.jobId ? ` (job ${r.jobId})` : ""}`).join(" | ") : "None recorded"}</dd></div>
                          <div className="sm:col-span-2"><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Evidence references</dt><dd className="text-xs text-fg/90 break-words">{inv.evidenceReferences?.length ? inv.evidenceReferences.join(" | ") : "None recorded"}</dd></div>
                          {linked ? <div className="sm:col-span-2"><dt className="text-[10px] text-muted uppercase tracking-[0.12em]">Linked verification record</dt><dd className="text-xs text-fg/90 break-words">{linked.id} · {linked.outcome}{linked.failingStep ? ` · ${linked.failingStep}` : ""}{linked.evidencePath ? ` · ${linked.evidencePath}` : ""}</dd></div> : null}
                        </dl>
                      </div>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <div id="intelligence-content">
      <Panel title="Intelligence content and drafts" description="Existing editorial drafts and publishing records. Drafts are real records; nothing here is fabricated.">
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Draft writing</div><div className="mt-1 text-sm text-fg">{ai.configured ? "AI writing help is connected" : "Using a simple built-in draft"}</div><div className="mt-1 text-xs text-muted">Drafts are based on real project updates and test results — never made up.</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Ready for review</div><div className="mt-1 text-2xl font-semibold text-fg">{ready.length}</div><div className="mt-1 text-xs text-muted">Drafts waiting for a developer decision.</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Published</div><div className="mt-1 text-2xl font-semibold text-fg">{published.length}</div><div className="mt-1 text-xs text-muted">Published items remain available in Reports/Stories.</div></div>
        </div>

        <div className="space-y-6">
          <section>
            <div className="mb-2 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Drafts ({drafts.length})</div>
            {drafts.length === 0 ? <p className="text-sm text-muted">No drafts in progress.</p> : (
              <ul className="space-y-4">{drafts.map((s) => <li key={s.id}><DraftActions story={s} /></li>)}</ul>
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Ready for review ({ready.length})</div>
            {ready.length === 0 ? <p className="text-sm text-muted">No drafts waiting for review.</p> : (
              <ul className="space-y-4">{ready.map((s) => <li key={s.id}><DraftActions story={s} /></li>)}</ul>
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Published ({published.length})</div>
            {published.length === 0 ? <p className="text-sm text-muted">No published intelligence yet.</p> : (
              <ul className="space-y-2 text-sm">
                {published.map((s) => {
                  const projectId = (s as Story & { projectId?: string }).projectId;
                  const projectName = projectId ? projectNames.get(projectId) || projectId : "No project linked";
                  return (
                    <li key={s.id} className="flex flex-col gap-2 rounded-lg border border-border/60 bg-bg/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium text-fg">{s.title}</div>
                        <div className="text-xs text-muted">{projectName} · Updated {fmtDate(s.updatedAt)}{s.publishedAt ? ` · Published ${fmtDate(s.publishedAt)}` : ""}</div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        <Link className="text-accent underline" href={`/stories/${s.slug}`}>View story</Link>
                        <Link className="text-accent underline" href="/reports">Open Reports</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {rejected.length > 0 ? (
            <section>
              <div className="mb-2 text-[10px] font-tech uppercase tracking-[0.14em] text-muted">Rejected / discarded drafts ({rejected.length})</div>
              <ul className="space-y-2 text-sm">
                {rejected.map((s) => (
                  <li key={s.id} className="rounded-lg border border-border/60 bg-bg/20 p-3">
                    <div className="font-medium text-fg">{s.title}</div>
                    <div className="text-xs text-muted">Rejected {s.rejectedAt ? fmtDate(s.rejectedAt) : "time unknown"} · Updated {fmtDate(s.updatedAt)}</div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Panel>
      </div>

      <Panel title="How intelligence, verification, and publishing relate" description="These areas are connected but intentionally distinct.">
        <div className="grid gap-3 md:grid-cols-3 text-sm text-muted">
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="font-medium text-fg">Verification</div><div className="mt-1 text-xs">Establishes what was actually checked and the real outcome. Blocked/incomplete checks are not project pass/fail.</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="font-medium text-fg">Intelligence</div><div className="mt-1 text-xs">Explains what the evidence means, why it matters, and what to do next. It does not duplicate full Activity/Verification timelines.</div></div>
          <div className="rounded-lg border border-border bg-bg/20 p-3"><div className="font-medium text-fg">Publishing</div><div className="mt-1 text-xs">Turns appropriate, evidence-backed intelligence into drafts and published reports. Never publish unverified technical claims as confirmed findings.</div></div>
        </div>
      </Panel>
    </div>
  );
}
