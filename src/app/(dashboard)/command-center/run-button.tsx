"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunPipelineButton() {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  async function run() {
    setRunning(true);
    setIsError(false);
    setMsg("Working... Checking for changes, testing, and writing a draft. This can take a few minutes if testing runs.");
    try {
      const res = await fetch("/api/agent/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) {
        setIsError(true);
        setMsg(data.error || "Something went wrong. Please try again.");
      } else if (data.draft) {
        setMsg(`Draft ready to review: "${data.draft.title}". Open "Review drafts" to edit, approve, or publish it.`);
      } else {
        setMsg(data.state?.note || "Run finished. Check the status below for details.");
      }
    } catch (e) {
      setIsError(true);
      setMsg(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-start md:items-end gap-2 w-full md:w-auto">
      <button
        onClick={run}
        disabled={running}
        className="px-4 py-2.5 rounded-md bg-accent text-black font-tech uppercase tracking-[0.12em] text-xs font-bold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed shadow-glow w-full md:w-auto"
        data-action="run-pipeline"
      >
        {running ? "Working..." : "Start a new check"}
      </button>
      <p className="text-xs text-muted max-w-sm md:text-right">Looks for new changes, tests them, and creates a draft for you to review.</p>
      {msg ? <p className={`text-xs max-w-md md:text-right ${isError ? "text-rose-300" : "text-muted"}`}>{msg}</p> : null}
    </div>
  );
}
