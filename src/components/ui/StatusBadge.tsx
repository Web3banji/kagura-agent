import type { VerificationOutcome } from "@/types/verification";
import { statusInfo } from "@/lib/ui-text";

type BadgeStatus = VerificationOutcome | "idle" | "none" | "completed" | "success" | "skipped";

const styles: Record<string, string> = {
  pending: "bg-white/5 text-muted border-border",
  running: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  passed: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  completed: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  blocked: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  did_not_start: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  timeout: "bg-orange-500/10 text-orange-300 border-orange-500/30",
  skipped: "bg-white/5 text-muted border-border",
  idle: "bg-white/5 text-muted border-border",
  none: "bg-white/5 text-muted border-border",
};

export function StatusBadge({ status, showHint = false }: { status: BadgeStatus; showHint?: boolean }) {
  const cls = styles[status] || "bg-white/5 text-muted border-border";
  const info = statusInfo(status);
  return (
    <span
      className={`inline-flex items-center text-xs px-2 py-1 rounded border font-medium ${cls}`}
      title={info.description || info.label}
    >
      {info.label}
      {showHint && info.description ? <span className="sr-only"> — {info.description}</span> : null}
    </span>
  );
}