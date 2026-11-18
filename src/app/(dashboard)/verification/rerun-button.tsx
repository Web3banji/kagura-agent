"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RerunVerificationButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true);
    setMsg("Queueing a verification job for the shared runner...");
    setErr(null);
    try {
      const res = await fetch("/api/verification/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow: "shell-nav" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The test could not be queued.");
      const jobId = data.jobId || data.job?.id;
      const status = data.status || data.job?.status || data.record?.outcome || "pending";
      if (status === "pending" || status === "claimed" || status === "running") {
        setMsg(`Verification queued${jobId ? ` (job ${jobId})` : ""}. The local runner will execute it and sync genuine results when available.`);
      } else {
        const r = data.record;
        const outcome = r?.outcome || status || "unknown";
        const summary = r?.summary ? ` ${r.summary}` : "";
        setMsg(`Test finished: ${outcome}.${summary}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMsg(null);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full md:w-auto">
      <button
        onClick={run}
        disabled={busy}
        className="w-full md:w-auto px-4 py-2.5 rounded-md bg-accent text-black font-tech uppercase tracking-[0.12em] text-xs font-bold hover:brightness-110 disabled:opacity-50 shadow-glow"
        data-action="rerun-verification"
      >
        {busy ? "Queueing..." : "Run a test now"}
      </button>
      {msg ? <p className="text-xs text-muted">{msg}</p> : null}
      {err ? <p className="text-xs text-rose-300">Something went wrong: {err}</p> : null}
      <p className="text-xs text-muted">Queues a real verification job for the shared local runner. Results appear here when the runner syncs them back.</p>
    </div>
  );
}
