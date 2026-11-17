"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ObserveButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  async function observe() {
    setBusy(true);
    setIsError(false);
    setMsg("Checking your project for new changes...");
    try {
      const res = await fetch("/api/github/observe", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) {
        setIsError(true);
        setMsg(data.error || "Could not check for changes. Please try again.");
      } else {
        const count = data.commits?.length ?? 0;
        const newly = data.newCommits?.length ?? 0;
        setMsg(`Checked ${data.repo || "your project"}: found ${count} recent update${count === 1 ? "" : "s"} (${newly} new).`);
      }
    } catch (e) {
      setIsError(true);
      setMsg(e instanceof Error ? e.message : "Could not check for changes. Please try again.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-start md:items-end gap-1 w-full md:w-auto">
      <button
        onClick={observe}
        disabled={busy}
        className="px-4 py-2.5 rounded-md border border-border-strong bg-panel-2/60 font-tech uppercase tracking-[0.12em] text-[11px] text-fg hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50 w-full md:w-auto"
        data-action="observe-repo"
      >
        {busy ? "Checking..." : "Check for changes"}
      </button>
      {msg ? <p className={`text-xs max-w-sm md:text-right ${isError ? "text-rose-300" : "text-muted"}`}>{msg}</p> : null}
    </div>
  );
}
