"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Story } from "@/types/story";

export function DraftActions({ story }: { story: Story }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState(story.title);
  const [subtitle, setSubtitle] = useState(story.subtitle);
  const [body, setBody] = useState(story.body);

  async function call(path: string, payload?: unknown, label?: string) {
    setBusy(label || path);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? { id: story.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      setMsg(label ? `${label} done.` : "Done.");
      router.refresh();
      return data;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const hasVerification = !!story.verification;
  const verificationLabel = hasVerification
    ? `${story.verification?.outcome === "passed" ? "Tested: looks good" : `Tested: ${story.verification?.outcome?.replace(/_/g, " ") || "see details"}`}`
    : "No test attached";

  return (
    <div className="rounded-lg border border-border bg-panel-2/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2 text-xs text-muted mb-2">
            <span className="px-2 py-0.5 rounded border border-border bg-panel">{story.status === "review" ? "Ready for your review" : story.status}</span>
            <span>{story.source.commits.length} update{story.source.commits.length === 1 ? "" : "s"} included</span>
            <span>{verificationLabel}</span>
          </div>
          <label className="text-xs text-muted block">Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full mt-1 bg-black/20 border border-border rounded px-3 py-2 text-sm font-medium text-fg"
              placeholder="Story title"
            />
          </label>
          <label className="text-xs text-muted block mt-2">Short summary (shown under the title)
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              className="w-full mt-1 bg-black/20 border border-border rounded px-3 py-2 text-sm text-muted"
              placeholder="A short description"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          <button onClick={() => call("/api/editorial/update", { id: story.id, title, subtitle, body }, "Saved")} disabled={!!busy} className="px-3 py-2 rounded-md border border-border bg-panel text-xs hover:bg-white/5 disabled:opacity-50">Save changes</button>
          <button onClick={() => call("/api/editorial/regenerate", { id: story.id }, "New draft created")} disabled={!!busy} className="px-3 py-2 rounded-md border border-accent/30 text-accent text-xs hover:bg-accent/10 disabled:opacity-50">Write a new draft</button>
          <button onClick={() => call("/api/editorial/reject", { id: story.id }, "Draft removed")} disabled={!!busy} className="px-3 py-2 rounded-md border border-rose-500/30 text-rose-300 text-xs hover:bg-rose-500/10 disabled:opacity-50">Discard draft</button>
          <button onClick={() => call("/api/editorial/publish", { id: story.id }, "Published")} disabled={!!busy} className="px-3 py-2 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-medium hover:bg-emerald-500/30 disabled:opacity-50">{busy === "Published" ? "Publishing..." : "Approve & publish"}</button>
        </div>
      </div>
      <p className="text-xs text-muted">Edit the story below, then save. When you’re happy with it, choose <strong>Approve &amp; publish</strong> to share it on the Stories page.</p>
      <label className="text-xs text-muted block">Story content
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full mt-1 bg-black/20 border border-border rounded p-3 text-sm text-fg/90 whitespace-pre-wrap leading-6"
          placeholder="Write or edit the story here..."
        />
      </label>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-accent">Show details used for this draft (for transparency)</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <div><span className="text-fg/80">What was observed:</span> {story.source.observationSummary}</div>
          <div>
            <div className="text-fg/80 mb-1">Project updates included:</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {story.source.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0,7)}</code> - {c.message}</li>)}
            </ul>
          </div>
          {story.source.changedFiles?.length ? <div><span className="text-fg/80">Files changed:</span> {story.source.changedFiles.slice(0,12).join(", ")}{story.source.changedFiles.length>12?"…":""}</div> : null}
          {story.verification ? (
            <div><span className="text-fg/80">Test result:</span> {story.verification.outcome?.replace(/_/g, " ")}{typeof story.verification.exitCode === "number" ? ` (code ${story.verification.exitCode})` : ""}{story.verification.summary ? ` — ${story.verification.summary}` : ""} {story.verification.testUrl ? <a className="text-accent underline ml-1" href={story.verification.testUrl} target="_blank" rel="noreferrer">View full test report</a> : null}</div>
          ) : <div>No test was attached to this draft.</div>}
        </div>
      </details>
      {msg ? <p className="text-xs text-emerald-300">{msg}</p> : null}
      {err ? <p className="text-xs text-rose-300">Something went wrong: {err}</p> : null}
    </div>
  );
}
