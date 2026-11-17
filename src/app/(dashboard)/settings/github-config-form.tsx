"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GitHubConfigForm({ initialOwner, initialRepo, configuredIn }: { initialOwner: string; initialRepo: string; configuredIn: string }) {
  const [owner, setOwner] = useState(initialOwner);
  const [repo, setRepo] = useState(initialRepo);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const locked = configuredIn === "env";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/github/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error || "Could not save. Please try again.");
      else { setMsg(`Saved: ${data.owner}/${data.repo}`); router.refresh(); }
    } catch (err) {
      setErr(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-2">
      <p className="text-xs text-muted">This tells KAGURA which project on GitHub to watch for changes.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-muted">Account or team name
          <input value={owner} onChange={(e) => setOwner(e.target.value)} disabled={locked} className="mt-1 w-full rounded border border-border bg-panel-2 px-2 py-1.5 text-sm text-fg disabled:opacity-60" placeholder="e.g. Web3banji" />
        </label>
        <label className="text-xs text-muted">Project name
          <input value={repo} onChange={(e) => setRepo(e.target.value)} disabled={locked} className="mt-1 w-full rounded border border-border bg-panel-2 px-2 py-1.5 text-sm text-fg disabled:opacity-60" placeholder="e.g. kagura-agent" />
        </label>
      </div>
      {locked ? <p className="text-xs text-muted">This is set by your site’s configuration and can’t be changed here.</p> : (
        <button type="submit" disabled={busy} className="px-3 py-1.5 rounded bg-accent/20 text-accent border border-accent/30 text-xs font-medium disabled:opacity-50">{busy ? "Saving..." : "Save project"}</button>
      )}
      {msg ? <p className="text-xs text-emerald-300">{msg}</p> : null}
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
    </form>
  );
}
