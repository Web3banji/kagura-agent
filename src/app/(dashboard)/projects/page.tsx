"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";
import { Button, Input, Label, Notification, StatusBadge } from "@/components/ui/elements";

type DiscoveredRepo = { githubRepoId: string; fullName: string; repoOwner: string; repoName: string; isPrivate: boolean | null };
type ProjectRepo = { connectionId: string; fullName: string; owner: string; name: string; isPrivate: boolean | null; defaultBranch: string | null; status: string; linkStatus: string; linkedAt: string } | null;
type Project = { id: string; owner_user_id: string; name: string; slug: string; is_bootstrap: boolean; created_at: string; updated_at: string; repository?: ProjectRepo };
type ProjectScanState = { status: "idle" | "running" | "success" | "error"; message?: string; lastRunAt?: string; lastResult?: { newCommits: number; failedRepositories: number; totalRepositories: number } };

function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function fmtDate(value?: string | null): string { if (!value) return "Not yet"; const d = new Date(value); if (Number.isNaN(d.getTime())) return "Not yet"; return d.toLocaleString(); }
function isConnectedRepo(repo: ProjectRepo): boolean { return !!repo && repo.status !== "revoked" && repo.status !== "error"; }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [registering, setRegistering] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error" | "info"; title: string; message?: string } | null>(null);
  const [scanStates, setScanStates] = useState<Record<string, ProjectScanState>>({});
  const [generalScan, setGeneralScan] = useState<ProjectScanState>({ status: "idle" });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setReposLoading(true); setReposError(null);
    try {
      const res = await fetch("/api/github/repositories", { headers: { Accept: "application/json" }, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load your GitHub repositories.");
      setRepos(Array.isArray(data.repositories) ? data.repositories : []);
    } catch (e) { setRepos([]); setReposError(e instanceof Error ? e.message : "Could not load your GitHub repositories."); }
    finally { setReposLoading(false); }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true); setProjectsError(null);
    try {
      const res = await fetch("/api/projects", { headers: { Accept: "application/json" }, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load projects.");
      const list = Array.isArray(data.projects) ? (data.projects as Project[]) : [];
      setProjects(list);
      setSelectedProjectId((current) => (current && list.some((p) => p.id === current) ? current : list[0]?.id ?? null));
    } catch (e) { setProjects([]); setProjectsError(e instanceof Error ? e.message : "Could not load projects."); }
    finally { setProjectsLoading(false); }
  }, []);

  useEffect(() => { void loadRepos(); void loadProjects(); }, [loadRepos, loadProjects]);

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const selectedRepo = useMemo(() => repos.find((r) => r.githubRepoId === selectedRepoId) ?? null, [repos, selectedRepoId]);

  async function handleSelectRepo(repo: DiscoveredRepo) {
    setRegistering(true); setSelectedRepoId(repo.githubRepoId); setSelectedConnectionId(""); setMsg(null);
    try {
      const res = await fetch("/api/github/repositories/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ githubRepoId: repo.githubRepoId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to connect repository.");
      setSelectedConnectionId(data.connection?.id || "");
      if (data.alreadyConnected) setMsg({ kind: "info", title: "Repository ready", message: `${repo.fullName} is already connected to your GitHub account.` });
    } catch (e) { setMsg({ kind: "error", title: "Could not connect repository", message: e instanceof Error ? e.message : "Please try again." }); setSelectedConnectionId(""); }
    finally { setRegistering(false); }
  }

  function resetCreateForm() { setName(""); setSlug(""); setSlugTouched(false); setSelectedRepoId(""); setSelectedConnectionId(""); }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const trimmedName = name.trim(); const effectiveSlug = (slug || slugify(trimmedName)).trim();
    if (!trimmedName) { setMsg({ kind: "error", title: "Project name required", message: "Give your project a name so you can recognize it later." }); return; }
    if (!selectedConnectionId) { setMsg({ kind: "error", title: "Repository required", message: "Select a GitHub repository for this project. Connecting your GitHub account and assigning a repository to a project are different steps." }); return; }
    setCreating(true);
    try {
      const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmedName, slug: effectiveSlug, repositoryConnectionId: selectedConnectionId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not create project.");
      const created: Project = { ...data.project, repository: data.repositoryConnection ? { connectionId: data.repositoryConnection.id, fullName: data.repositoryConnection.fullName, owner: data.repositoryConnection.repoOwner, name: data.repositoryConnection.repoName, isPrivate: data.repositoryConnection.isPrivate ?? null, defaultBranch: data.repositoryConnection.defaultBranch ?? null, status: data.repositoryConnection.status ?? "active", linkStatus: "active", linkedAt: new Date().toISOString() } : null };
      setProjects((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
      setSelectedProjectId(created.id); setShowCreate(false); resetCreateForm();
      setMsg({ kind: "success", title: "Project created", message: `${created.name} is ready. You can run a project-specific scan when you want KAGURA to check its assigned repository.` });
    } catch (e) { setMsg({ kind: "error", title: "Could not create project", message: e instanceof Error ? e.message : "Please try again." }); }
    finally { setCreating(false); }
  }

  async function runProjectScan(project: Project) {
    setScanStates((prev) => ({ ...prev, [project.id]: { status: "running", message: "Checking this project's repository..." } }));
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/github/observe`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not scan this project.");
      const newCommits = Number(data.totalNewCommits ?? 0);
      const failedRepos = Number(data.failedRepositories ?? 0);
      const totalRepos = Number(data.totalRepositories ?? 0);
      const ok = data.status === "success" || data.status === "partial";
      const msgText = ok ? `Scan complete. ${newCommits} new update${newCommits === 1 ? "" : "s"} found${failedRepos > 0 ? `, ${failedRepos} repository check${failedRepos === 1 ? "" : "s"} had issues` : ""}.` : (data.error || "The project scan could not be completed.");
      setScanStates((prev) => ({ ...prev, [project.id]: { status: ok ? "success" : "error", lastRunAt: data.observedAt || new Date().toISOString(), lastResult: { newCommits, failedRepositories: failedRepos, totalRepositories: totalRepos }, message: msgText } }));
      if (!ok) setMsg({ kind: "error", title: "Project scan had issues", message: data.error || "KAGURA could not complete this project scan." });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not scan this project.";
      setScanStates((prev) => ({ ...prev, [project.id]: { status: "error", message } }));
      setMsg({ kind: "error", title: "Project scan failed", message });
    }
  }

  async function runGeneralScan() {
    setGeneralScan({ status: "running", message: "Running a general scan (not tied to a selected project)..." });
    try {
      const res = await fetch("/api/github/observe", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not run the general scan.");
      const newCommits = Array.isArray(data.newCommits) ? data.newCommits.length : Number(data.newCommits ?? 0);
      setGeneralScan({ status: "success", lastRunAt: data.observedAt || new Date().toISOString(), message: `General scan complete. ${newCommits} new update${newCommits === 1 ? "" : "s"} found.` });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not run the general scan.";
      setGeneralScan({ status: "error", message }); setMsg({ kind: "error", title: "General scan failed", message });
    }
  }

  const connectedRepoCount = projects.filter((p) => isConnectedRepo(p.repository ?? null)).length;

  return (
    <div className="space-y-6" data-page="projects">
      <PageHeader
        title="Projects"
        subtitle="Manage the projects KAGURA watches. Each project can have one assigned repository for project-specific scans."
        actions={
          <div className="flex flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => void loadProjects()} disabled={projectsLoading}>{projectsLoading ? "Refreshing..." : "Refresh"}</Button>
            <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "Close form" : "New project"}</Button>
          </div>
        }
      />

      {msg ? <Notification kind={msg.kind} title={msg.title} message={msg.message} onDismiss={() => setMsg(null)} /> : null}

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Project overview" description="A simple view of your projects, their repository connection, and what KAGURA is watching.">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-panel-2/20 p-4"><div className="text-xs uppercase tracking-[0.12em] text-muted">Projects</div><div className="mt-2 text-2xl font-semibold text-fg">{projects.length}</div><p className="mt-1 text-xs text-muted">Projects in your workspace.</p></div>
            <div className="rounded-lg border border-border bg-panel-2/20 p-4"><div className="text-xs uppercase tracking-[0.12em] text-muted">Repositories assigned</div><div className="mt-2 text-2xl font-semibold text-fg">{connectedRepoCount}</div><p className="mt-1 text-xs text-muted">Projects with an active repository assignment.</p></div>
            <div className="rounded-lg border border-border bg-panel-2/20 p-4"><div className="text-xs uppercase tracking-[0.12em] text-muted">GitHub account</div><div className="mt-2 text-sm font-semibold text-fg">{reposLoading ? "Checking..." : reposError ? "Needs attention" : repos.length > 0 ? "Connected" : "Not connected"}</div><p className="mt-1 text-xs text-muted">{reposLoading ? "Checking available repositories." : reposError ? "KAGURA could not read your GitHub repositories." : repos.length > 0 ? "You can assign repositories to projects." : "Connect GitHub in Integrations to assign repositories."}</p></div>
          </div>
          <div className="mt-4 rounded-lg border border-border bg-panel-2/10 p-3 text-xs text-muted leading-relaxed">
            <span className="text-fg font-medium">Scan types: </span>
            <span className="text-fg/90">Project-specific scan</span> checks the repository assigned to a selected project. <span className="text-fg/90">General scan</span> is separate and not tied to a selected project.
          </div>
        </Panel>

        <Panel title="General scan" description="Runs independently of any selected project. Use project scans for repository-specific checks.">
          <div className="space-y-3">
            <p className="text-sm text-muted leading-relaxed">A general scan looks for changes using KAGURA’s general observation flow. It does not replace a project-specific repository scan.</p>
            <Button variant="outline" onClick={() => void runGeneralScan()} disabled={generalScan.status === "running"}>{generalScan.status === "running" ? "Scanning..." : "Run general scan"}</Button>
            {generalScan.message ? <p className={`text-xs ${generalScan.status === "error" ? "text-rose-300" : "text-muted"}`}>{generalScan.message}{generalScan.lastRunAt ? ` (${fmtDate(generalScan.lastRunAt)})` : ""}</p> : <p className="text-xs text-muted">No general scan run in this session yet.</p>}
          </div>
        </Panel>
      </section>

      {showCreate ? (
        <Panel title="Create a project" description="A project is a workspace item in KAGURA. Assign one GitHub repository so KAGURA knows what to scan for that project.">
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>Project name</Label>
                <Input value={name} onChange={(e) => { const next = e.target.value; setName(next); if (!slugTouched) setSlug(slugify(next)); }} placeholder="e.g. KAGURA website" disabled={creating} />
                <p className="mt-1 text-xs text-muted">Use a name people will recognize.</p>
              </div>
              <div>
                <Label>Project ID (slug)</Label>
                <Input value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} placeholder="kagura-website" disabled={creating} />
                <p className="mt-1 text-xs text-muted">Used in links and internal references. Letters, numbers, and hyphens only.</p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-panel-2/15 p-4 space-y-3">
              <div>
                <Label>GitHub repository for this project</Label>
                <p className="text-xs text-muted mt-1 leading-relaxed">First, KAGURA needs access to your GitHub account (done in Integrations). Then you assign a specific repository to this project. This selection only assigns the repository to the project you are creating.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <select value={selectedRepoId} onChange={(e) => { const repo = repos.find((r) => r.githubRepoId === e.target.value); if (repo) void handleSelectRepo(repo); else { setSelectedRepoId(""); setSelectedConnectionId(""); } }} disabled={creating || reposLoading || registering} className="w-full rounded-md border border-border bg-panel-2/60 px-3 py-2 text-sm text-fg">
                  <option value="">{reposLoading ? "Loading repositories..." : "Select a repository"}</option>
                  {repos.map((r) => <option key={r.githubRepoId} value={r.githubRepoId}>{r.fullName}{r.isPrivate ? " (private)" : ""}</option>)}
                </select>
                <Button type="button" variant="outline" onClick={() => void loadRepos()} disabled={reposLoading || registering || creating}>{reposLoading ? "Loading..." : "Reload repos"}</Button>
              </div>
              {reposError ? <div className="rounded-md border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-200"><div className="font-medium">Could not load GitHub repositories</div><div className="mt-1">{reposError}</div><div className="mt-2"><Link href="/integrations" className="text-accent underline">Open Integrations</Link> to connect or recheck your GitHub account.</div></div> : null}
              {!reposLoading && !reposError && repos.length === 0 ? <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200">No GitHub repositories were found for your account. Connect GitHub in <Link href="/integrations" className="text-accent underline">Integrations</Link>, then come back here.</div> : null}
              {registering ? <p className="text-xs text-muted">Connecting repository to KAGURA...</p> : null}
              {selectedRepo && selectedConnectionId ? <p className="text-xs text-emerald-300">Repository ready: {selectedRepo.fullName}. It will be assigned to this project when you create it.</p> : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="primary" type="submit" disabled={creating || registering || !name.trim() || !selectedConnectionId}>{creating ? "Creating..." : "Create project"}</Button>
              <Button type="button" variant="ghost" onClick={() => { setShowCreate(false); resetCreateForm(); setMsg(null); }} disabled={creating}>Cancel</Button>
            </div>
          </form>
        </Panel>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <Panel title={`Your projects (${projects.length})`} description="Select a project to see details. Project-specific scans only check the repository assigned to that project.">
          {projectsLoading ? (
            <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="rounded-lg border border-border bg-panel-2/20 p-4 animate-pulse"><div className="h-4 w-40 bg-white/10 rounded" /><div className="mt-2 h-3 w-64 bg-white/5 rounded" /><div className="mt-3 h-3 w-32 bg-white/5 rounded" /></div>)}</div>
          ) : projectsError ? (
            <EmptyState title="Could not load projects" detail={projectsError} action={<Button variant="outline" onClick={() => void loadProjects()}>Try again</Button>} />
          ) : projects.length === 0 ? (
            <EmptyState title="No projects yet" detail="Create a project and assign a GitHub repository so KAGURA can run project-specific checks." action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create a project</Button>} />
          ) : (
            <ul className="space-y-3">
              {projects.map((p) => {
                const repo = p.repository ?? null;
                const connected = isConnectedRepo(repo);
                const scan = scanStates[p.id];
                const selected = p.id === selectedProjectId;
                return (
                  <li key={p.id}>
                    <button type="button" onClick={() => setSelectedProjectId(p.id)} className={`w-full text-left rounded-lg border p-4 transition ${selected ? "border-accent/40 bg-accent-soft/10" : "border-border bg-panel-2/20 hover:border-border-strong"}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-fg">{p.name}</span>
                            {p.is_bootstrap ? <span className="text-[10px] px-2 py-0.5 rounded border border-success/30 bg-success/10 text-success font-tech uppercase tracking-[0.12em]">Bootstrap</span> : null}
                            <span className={`text-[10px] px-2 py-0.5 rounded border font-tech uppercase tracking-[0.12em] ${connected ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>{connected ? "Connected" : "No repository"}</span>
                          </div>
                          <div className="mt-1 text-xs text-muted break-all">{repo ? repo.fullName : "No repository assigned"}</div>
                        </div>
                        <div className="text-xs text-muted shrink-0">Updated {fmtDate(p.updated_at)}</div>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
                        <div className="rounded border border-border/70 bg-panel/30 p-2.5"><div className="text-muted uppercase tracking-[0.12em]">Monitoring</div><div className="mt-1 text-fg/90">{connected ? "Ready for project scans" : "Assignment needed"}</div></div>
                        <div className="rounded border border-border/70 bg-panel/30 p-2.5"><div className="text-muted uppercase tracking-[0.12em]">Last activity</div><div className="mt-1 text-fg/90">{scan?.lastRunAt ? fmtDate(scan.lastRunAt) : fmtDate(p.updated_at)}</div></div>
                        <div className="rounded border border-border/70 bg-panel/30 p-2.5"><div className="text-muted uppercase tracking-[0.12em]">Last scan</div><div className="mt-1 text-fg/90">{scan?.status === "success" ? "Completed" : scan?.status === "error" ? "Needs attention" : scan?.status === "running" ? "Running" : "Not run in this session"}</div></div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button variant="outline" size="sm" onClick={() => void runProjectScan(p)} disabled={scan?.status === "running" || !connected} title={!connected ? "Assign a repository to run a project-specific scan" : "Scan the repository assigned to this project"}>{scan?.status === "running" ? "Scanning..." : "Scan this project"}</Button>
                        <Link href="/verification" className="inline-flex items-center justify-center rounded-md border border-border px-2.5 py-1.5 text-[11px] font-tech uppercase tracking-[0.14em] text-fg hover:bg-black/5 dark:hover:bg-white/[0.03]">View checks</Link>
                      </div>
                      {scan?.message ? <p className={`mt-2 text-xs ${scan.status === "error" ? "text-rose-300" : "text-muted"}`}>{scan.message}</p> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Project details" description="Details for the selected project. This helps you understand what KAGURA is monitoring.">
          {!selectedProject ? (
            <EmptyState title="No project selected" detail="Select a project from the list to see its details." />
          ) : (
            <div className="space-y-4">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-fg">{selectedProject.name}</h3>{selectedProject.is_bootstrap ? <StatusBadge status="completed" className="!normal-case !tracking-normal !font-sans" /> : null}</div>
                <p className="mt-1 text-sm text-muted leading-relaxed">This project represents a workspace item in KAGURA. KAGURA uses its assigned repository for project-specific scans and monitoring.</p>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="rounded-lg border border-border bg-panel-2/20 p-3"><dt className="text-xs uppercase tracking-[0.12em] text-muted">Assigned repository</dt><dd className="mt-1 font-medium text-fg break-all">{selectedProject.repository?.fullName || "No repository assigned"}</dd><dd className="mt-1 text-xs text-muted">{selectedProject.repository ? `GitHub repository ${selectedProject.repository.isPrivate ? "(private)" : "(public)"} · Default branch: ${selectedProject.repository.defaultBranch || "unknown"}` : "Assign a repository when creating a project to enable project-specific scans."}</dd></div>
                <div className="rounded-lg border border-border bg-panel-2/20 p-3"><dt className="text-xs uppercase tracking-[0.12em] text-muted">What KAGURA monitors</dt><dd className="mt-1 text-sm text-fg/90 leading-relaxed">{selectedProject.repository ? "KAGURA can check this project's assigned repository for changes and run project-specific scans. General scans remain separate." : "KAGURA cannot run a project-specific repository scan until a repository is assigned."}</dd></div>
                <div className="rounded-lg border border-border bg-panel-2/20 p-3"><dt className="text-xs uppercase tracking-[0.12em] text-muted">Recent checks and discoveries</dt><dd className="mt-1 text-sm text-fg/90">{scanStates[selectedProject.id]?.lastRunAt ? `Last project scan in this session: ${fmtDate(scanStates[selectedProject.id]?.lastRunAt)}` : "No project scan run in this session yet."}</dd><dd className="mt-1 text-xs text-muted leading-relaxed">{scanStates[selectedProject.id]?.message || "Run a project scan to check the assigned repository for new updates."}</dd></div>
              </dl>
              <div className="rounded-lg border border-accent/20 bg-accent-soft/10 p-3">
                <div className="text-xs uppercase tracking-[0.12em] text-accent/80">Next useful action</div>
                <p className="mt-1 text-sm text-fg">{selectedProject.repository ? "Run a project-specific scan to check this repository for new changes." : "Create or reconnect a project with a repository to enable project-specific monitoring."}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" onClick={() => void runProjectScan(selectedProject)} disabled={!isConnectedRepo(selectedProject.repository ?? null) || scanStates[selectedProject.id]?.status === "running"}>{scanStates[selectedProject.id]?.status === "running" ? "Scanning..." : "Scan this project"}</Button>
                  <Button variant="outline" size="sm" onClick={() => void runGeneralScan()} disabled={generalScan.status === "running"}>{generalScan.status === "running" ? "Scanning..." : "Run general scan"}</Button>
                </div>
                <p className="mt-2 text-[11px] text-muted">General scan is separate and not tied to this selected project.</p>
              </div>
              <details className="text-xs text-muted"><summary className="cursor-pointer text-accent">Advanced details</summary><div className="mt-2 space-y-1 break-all"><div>Project ID: <span className="font-mono">{selectedProject.id}</span></div><div>Slug: <span className="font-mono">{selectedProject.slug}</span></div><div>Created: {fmtDate(selectedProject.created_at)}</div><div>Updated: {fmtDate(selectedProject.updated_at)}</div>{selectedProject.repository ? <><div>Repository connection ID: <span className="font-mono">{selectedProject.repository.connectionId}</span></div><div>Repository status: {selectedProject.repository.status}</div><div>Link status: {selectedProject.repository.linkStatus}</div></> : null}</div></details>
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}
