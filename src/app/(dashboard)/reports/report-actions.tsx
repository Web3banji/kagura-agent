"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/elements";

type PromptItem = { id: string; title: string; prompt: string | null };
type AiReport = { provider: string; model?: string; generatedAt: string; body: string };

export function ReportActions({
  reportId,
  aiReport,
  prompts,
}: {
  reportId: string;
  aiReport?: AiReport | null;
  prompts: PromptItem[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/generate-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "AI report generation failed.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Clipboard access was denied by the browser.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ai/25 bg-ai-soft/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="k-label text-ai/90">AI-assisted analysis</div>
            <div className="mt-1 text-sm font-medium text-fg">
              {aiReport ? "AI report generated" : "Generate an AI report from this verification"}
            </div>
            <p className="mt-1 text-xs text-muted leading-relaxed">
              Uses the original verification record and linked findings. Gemini never invents results.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void generate()} loading={busy} disabled={busy || !!aiReport}>
            {aiReport ? "AI report ready" : busy ? "Generating..." : "Generate AI Report"}
          </Button>
        </div>
        {error ? <div className="mt-3 rounded border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div> : null}
        {aiReport ? (
          <div className="mt-4 border-t border-border/70 pt-4">
            <div className="text-[10px] font-tech uppercase tracking-[0.14em] text-muted">
              {aiReport.provider}
              {aiReport.model ? ` · ${aiReport.model}` : ""} · generated {new Date(aiReport.generatedAt).toLocaleString()}
            </div>
            <pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/90 overflow-x-auto">{aiReport.body}</pre>
          </div>
        ) : null}
      </div>

      {prompts.length > 0 ? (
        <div className="rounded-lg border border-border/70 bg-bg/15 p-4">
          <div className="k-label mb-2">Issue-specific fix prompts</div>
          <div className="space-y-3">
            {prompts.map((item) => (
              <details key={item.id} className="rounded border border-border/70 bg-panel-2/20 p-3">
                <summary className="cursor-pointer text-sm font-medium text-fg">{item.title}</summary>
                {item.prompt ? (
                  <>
                    <pre className="mt-3 whitespace-pre-wrap rounded border border-border bg-black/10 p-3 text-xs text-fg/90 overflow-x-auto">{item.prompt}</pre>
                    <div className="mt-2 flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => void copy(item.id, item.prompt || "")}>
                        {copied === item.id ? "Copied" : "Copy fix prompt"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-muted">No fix prompt is recorded for this issue.</p>
                )}
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}