"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";
import { Button, Input, Label, Notification } from "@/components/ui/elements";

type Project = {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  is_bootstrap: boolean;
  created_at: string;
  updated_at: string;
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; title: string; message?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setProjects(data.projects || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMsg(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create project.");
      setMsg({ kind: "success", title: "Project created", message: `${data.project.name} is ready.` });
      setName("");
      setSlug("");
      setProjects((prev) => [...prev, data.project]);
    } catch (e) {
      setMsg({ kind: "error", title: "Could not create project", message: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        subtitle="Your authorized projects. Create a project to group activity, verification, and reports."
      />

      {msg && (
        <Notification kind={msg.kind} title={msg.title} message={msg.message} onDismiss={() => setMsg(null)} />
      )}

      <Panel title="Create a project" description="Give your project a name. A slug is generated automatically.">
        <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div className="col-span-3 sm:col-span-3">
            <Label>Project name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. KAGURA website" disabled={creating} />
          </div>
          <div className="sm:col-span-1">
            <Label>Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} disabled={creating} placeholder="kagura-website" />
          </div>
          <div className="sm:col-span-1 self-end">
            <Button variant="primary" type="submit" disabled={creating || !name}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={`Your projects (${projects.length})`}>
        {projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            detail="Create your first project to group activity, checks, and reports."
            action={<p className="text-xs text-muted">A bootstrap project is created automatically when you sign in with GitHub.</p>}
          />
        ) : (
          <ul className="divide-y divide-border">
            {projects.map((p) => (
              <li key={p.id} className="py-4 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/projects/${p.id}`} className="text-sm font-medium text-fg hover:text-accent">
                      {p.name}
                    </Link>
                    {p.is_bootstrap && (
                      <span className="text-[10px] px-2 py-0.5 rounded border border-success/30 bg-success/10 text-success font-tech">
                        bootstrap
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted mt-0.5">{p.slug}</div>
                </div>
                <div className="text-xs text-muted">{new Date(p.created_at).toLocaleDateString()}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
