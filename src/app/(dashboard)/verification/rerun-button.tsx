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
    setMsg("Running a test now... This can take a few minutes.");
    setErr(null);
    try {
      const res = await fetch("/api/verification/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow: "shell-nav" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The test could not be run.");
      const r = data.record;
      const outcome = r?.outcome || "unknown";
      const summary = r?.summary ? ` ${r.summary}` : "";
      setMsg(`Test finished: ${outcome}.${summary}`);
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
        className="w-full md:w-auto px-4 py-2.5 rounded-md bg-accent text-black font-semibold text-sm hover:opacity-90 disabled:opacity-50"
        data-action="rerun-verification"
      >
        {busy ? "Testing..." : "Run a test now"}
      </button>
      {msg ? <p className="text-xs text-muted">{msg}</p> : null}
      {err ? <p className="text-xs text-rose-300">Something went wrong: {err}</p> : null}
      <p className="text-xs text-muted">This opens your app and checks that the main pages work. It may take a few minutes and records a real result.</p>
    </div>
  );
}
