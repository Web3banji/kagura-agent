"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Panel } from "@/components/ui/Primitives";
import { Button, Input, Label, Notification } from "@/components/ui/elements";
export default function OnboardingPage() {
  const [projects, setProjects] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; title: string; message?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setProjects(data.projects || []);
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
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
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create project.");
      setMsg({ kind: "success", title: "Project created", message: `Welcome to ${data.project.name}.` });
      setName("");
      setProjects((prev) => [...prev, data.project]);
    } catch (e) {
      setMsg({ kind: "error", title: "Could not create project", message: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setCreating(false);
    }
  }

  const hasProjects = projects.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Welcome to KAGURA" subtitle="Understand your projects, see what’s changing, and know what needs attention." />

      {msg && (
        <Notification kind={msg.kind} title={msg.title} message={msg.message} onDismiss={() => setMsg(null)} />
      )}

      {!loading && !hasProjects ? (
        <>
          <Panel title="Set up your first project">
            <p className="text-sm text-muted mb-3">
              A project groups activity, checks, and reports. You can create one now, or connect GitHub in Settings to watch a repository.
            </p>
            <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div className="col-span-3 sm:col-span-3">
                <Label>Project name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My website" disabled={creating} />
              </div>
              <div className="sm:col-span-1 self-end">
                <Button variant="primary" type="submit" disabled={creating || !name}>
                  {creating ? "Creating…" : "Create project"}
                </Button>
              </div>
            </form>
            <p className="text-xs text-muted mt-3">
              Prefer to connect GitHub?{" "}
              <Link href="/settings" className="text-accent underline">
                Configure GitHub in Settings
              </Link>
              .
            </p>
          </Panel>

          <Panel title="What happens next">
            <ol className="list-decimal pl-5 space-y-2 text-sm text-muted">
              <li>Create or select a project.</li>
              <li>Check for changes on the Overview page.</li>
              <li>Run a verification to test your app.</li>
              <li>Review and publish a story.</li>
            </ol>
          </Panel>
        </>
      ) : (
        <div>
          {loading ? (
            <Panel title="Getting ready…">
              <p className="text-sm text-muted">Loading your projects.</p>
            </Panel>
          ) : null}
          <p className="text-sm text-muted">
            You already have projects set up. Head to the{" "}
            <Link href="/command-center" className="text-accent underline">
              Overview
            </Link>
            to see what’s happening.
          </p>
          <div className="flex gap-2">
            <Link href="/command-center">
              <Button variant="primary" size="sm">Go to Overview</Button>
            </Link>
            <Link href="/projects" className="text-sm text-accent underline">
              Manage projects →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
