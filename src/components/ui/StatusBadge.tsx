import type { VerificationOutcome } from "@/types/verification";

const styles: Record<VerificationOutcome, string> = {
  pending: "bg-white/5 text-muted border-border",
  running: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  passed: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  blocked: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  did_not_start: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  timeout: "bg-orange-500/10 text-orange-300 border-orange-500/30",
};

export function StatusBadge({ status }: { status: VerificationOutcome | "idle" | "none" }) {
  if (status === "idle" || status === "none") {
    return <span className="inline-flex text-xs px-2 py-1 rounded border bg-white/5 text-muted border-border">{status}</span>;
  }
  return (
    <span className={`inline-flex text-xs px-2 py-1 rounded border uppercase tracking-wide ${styles[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}