"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ObserveAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  async function run() {
    setBusy(true); setMsg("Checking for changes..."); setErr(null);
    try {
      const res = await fetch("/api/github/observe", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) { setErr(data.error || "Could not check for changes."); setMsg(null); }
      else { setMsg(`Found ${data.commits?.length ?? 0} recent update(s), ${data.newCommits?.length ?? 0} new.`); }
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not check for changes."); setMsg(null); }
    finally { setBusy(false); router.refresh(); }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 mt-3">
      <button onClick={run} disabled={busy} className="px-3 py-2 rounded-md border border-border-strong bg-panel-2/60 font-tech uppercase tracking-[0.12em] text-[11px] hover:border-accent/40 hover:text-accent disabled:opacity-50" data-action="observe-repo-settings">
        {busy ? "Checking..." : "Check for changes now"}
      </button>
      {msg ? <span className="text-xs text-emerald-300">{msg}</span> : null}
      {err ? <span className="text-xs text-rose-300">{err}</span> : null}
    </div>
  );
}
