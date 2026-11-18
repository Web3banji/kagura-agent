"use client";

import type { VerificationOutcome } from "@/types/verification";

export type ShellUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  githubId?: string | null;
  githubLogin?: string | null;
  isBootstrapOwner?: boolean;
} | null;

/* ─────────────────────────────────────────────
   Button
   ───────────────────────────────────────────── */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "success";

export function Button({
  children,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  onClick,
  className,
  type = "button",
  ...props
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  className?: string;
  type?: "button" | "submit" | "reset";
  [key: string]: unknown;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 font-tech uppercase tracking-[0.14em] rounded-md border transition-all disabled:opacity-50 disabled:pointer-events-none";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-black border-accent hover:bg-accent-2 active:bg-accent-2 shadow-glow",
    secondary: "bg-panel/60 text-fg border-border hover:bg-white/50 dark:hover:bg-white/[0.06]",
    outline: "border-border text-fg hover:bg-black/5 dark:hover:bg-white/[0.03]",
    ghost: "text-fg hover:bg-black/5 dark:hover:bg-white/[0.03]",
    danger: "border-danger-soft text-danger bg-danger/10 hover:bg-danger/20",
    success: "border-success-soft text-success bg-success/10 hover:bg-success/20",
  };
  const sizes: Record<string, string> = {
    sm: "text-[11px] px-2.5 py-1.5",
    md: "text-xs px-3 py-2",
    lg: "text-sm px-4 py-2.5",
  };
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className ?? ""}`}
      {...props}
    >
      {loading && (
        <span className="relative flex items-center justify-center w-4 h-4">
          <span className="animate-spin block h-full w-full rounded-full border-2 border-current border-t-transparent"></span>
        </span>
      )}
      {!loading && children}
    </button>
  );
}

/* ─────────────────────────────────────────────
   Input
   ───────────────────────────────────────────── */
export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex-1 min-w-0 bg-white/50 dark:bg-white/[0.03] border border-border rounded-md px-3 py-1.5 text-sm text-fg placeholder-text-muted/70 focus:outline-none focus:ring-1 focus:ring-accent disabled:bg-white/20 dark:disabled:bg-white/[0.02] ${className ?? ""}`}
      {...props}
    />
  );
}

/* ─────────────────────────────────────────────
   Textarea
   ───────────────────────────────────────────── */
export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`block w-full bg-white/50 dark:bg-white/[0.03] border border-border rounded-md px-3 py-1.5 text-sm text-fg placeholder-text-muted/70 focus:outline-none focus:ring-1 focus:ring-accent disabled:bg-white/20 dark:disabled:bg-white/[0.02] ${className ?? ""}`}
      {...props}
    />
  );
}

/* ─────────────────────────────────────────────
   Select
   ───────────────────────────────────────────── */
export function Select({
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex-1 min-w-0 bg-white/50 dark:bg-white/[0.03] border border-border rounded-md px-3 py-1.5 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent ${className ?? ""}`}
      {...props}
    >
      {children}
    </select>
  );
}

/* ─────────────────────────────────────────────
   Label
   ───────────────────────────────────────────── */
export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs font-medium text-fg/90 mb-1 ${className ?? ""}`}>{children}</label>
  );
}

/* ─────────────────────────────────────────────
   KLabel (small mono label, reuse style)
   ───────────────────────────────────────────── */
export function KLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`k-label ${className ?? ""}`}>{children}</span>
  );
}

/* ─────────────────────────────────────────────
   Card
   ───────────────────────────────────────────── */
export function Card({
  children,
  className,
  padded = true,
  ...props
}: { children: React.ReactNode; className?: string; padded?: boolean } & Record<string, unknown>) {
  return (
    <div
      className={`k-surface p-4 md:p-5 ${padded ? "p-4 md:p-5" : ""} ${className ?? ""}`}
      {...props}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────
   Panel (page section wrapper)
   ───────────────────────────────────────────── */
export function Panel({
  children,
  title,
  description,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={`k-surface ${className ?? ""}`}>
      {title || description ? (
        <div className="px-4 pb-2">
          {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
          {description && <p className="text-xs text-muted mt-0.5 leading-relaxed">{description}</p>}
        </div>
      ) : null}
      <div className="px-4 pt-2">{children}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   EmptyState
   ───────────────────────────────────────────── */
export function EmptyState({
  title,
  detail,
  action,
  className,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-3 px-4 text-center ${className ?? ""}`}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="text-xs text-muted leading-relaxed max-w-xs">{detail}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ─────────────────────────────────────────────
   StatusBadge (reuse semantics, new styling)
   ───────────────────────────────────────────── */
export function StatusBadge({
  status,
  className,
}: { status: string | VerificationOutcome; className?: string }) {
  const variants: Record<string, string> = {
    passed: "bg-success/10 text-success border-success/30",
    failed: "bg-danger/10 text-danger border-danger/30",
    blocked: "bg-warning/10 text-warning border-warning/30",
    did_not_start: "bg-warning/10 text-warning border-warning/30",
    timeout: "bg-warning/10 text-warning border-warning/30",
    running: "bg-info/10 text-info border-info/30",
    pending: "bg-muted-soft/30 text-muted border-muted/30",
    completed: "bg-success/10 text-success border-success/30",
    success: "bg-success/10 text-success border-success/30",
    idle: "bg-muted-soft/30 text-muted border-muted/30",
    none: "bg-muted-soft/30 text-muted border-muted/30",
    skipped: "bg-muted-soft/30 text-muted border-muted/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-tech uppercase tracking-[0.18em] font-semibold ${variants[String(status).toLowerCase()] ?? variants.pending} ${className ?? ""}`}
    >
      {String(status).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
    </span>
  );
}

/* ─────────────────────────────────────────────
   Skeleton
   ───────────────────────────────────────────── */
export function Skeleton({
  className,
  h = "1em",
  w = "100%",
}: { className?: string; h?: string; w?: string }) {
  return (
    <div
      className={`h-${h === "1em" ? "4" : "auto"} w-${w === "100%" ? "full" : "auto"} rounded-md bg-border-strong animate-pulse ${className ?? ""}`}
      style={{ height: h, width: w }}
      aria-hidden="true"
    />
  );
}

/* ─────────────────────────────────────────────
   AIInsight
   ───────────────────────────────────────────── */
export function AIInsight({
  title,
  explanation,
  why,
  evidence,
  nextStep,
  kind = "info",
}: {
  title: string;
  explanation: string;
  why?: string;
  evidence?: string;
  nextStep?: string;
  kind?: "info" | "ai" | "success" | "warning" | "danger";
}) {
  const color = kind === "ai" ? "ai" : kind === "success" ? "success" : kind === "warning" ? "warning" : kind === "danger" ? "danger" : "info";
  return (
    <Card padded>
      <div className="flex gap-3">
        <div className={`shrink-0 rounded-md p-1.5 ${color === "ai" ? "bg-ai-soft text-ai" : color === "success" ? "bg-success-soft text-success" : color === "warning" ? "bg-warning-soft text-warning" : color === "danger" ? "bg-danger-soft text-danger" : "bg-info-soft text-info"}`}>
          {kind === "ai" ? "✦" : kind === "success" ? "✓" : kind === "warning" ? "!" : kind === "danger" ? "✕" : "i"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1">
            <KLabel>{kind === "ai" ? "AI intelligence" : kind}</KLabel>
            <span className="text-[10px] font-medium text-fg/90">{title}</span>
          </div>
          <p className="text-xs text-fg/90 leading-relaxed">{explanation}</p>
          {why && (
            <div className="mt-2 text-xs text-muted leading-relaxed">
              <span className="font-semibold text-fg">Why it matters:</span>{" "}
              {why}
            </div>
          )}
          {evidence && (
            <div className="mt-2 text-xs text-muted/80 leading-relaxed break-all">
              <span className="font-semibold text-fg/80">Evidence:</span>{" "}
              {evidence}
            </div>
          )}
          {nextStep && (
            <div className="mt-2 text-xs text-accent leading-relaxed">
              <span className="font-semibold">Next step:</span>{" "}
              {nextStep}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ─────────────────────────────────────────────
   Notification banner
   ───────────────────────────────────────────── */
export function Notification({
  kind,
  title,
  message,
  dismissible = true,
  onDismiss,
  retry,
  retryLabel = "Try again",
}: {
  kind: "success" | "warning" | "error" | "info";
  title: string;
  message?: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  retry?: () => void;
  retryLabel?: string;
}) {
  const theme = {
    success: { bg: "bg-success-soft", border: "border-success/30", text: "text-success", icon: "✓" },
    warning: { bg: "bg-warning-soft", border: "border-warning/30", text: "text-warning", icon: "!" },
    error: { bg: "bg-danger-soft", border: "border-danger/30", text: "text-danger", icon: "✕" },
    info: { bg: "bg-info-soft", border: "border-info/30", text: "text-info", icon: "i" },
  }[kind];
  return (
    <div className={`k-surface p-3 mb-3 flex items-start gap-3 ${theme.bg} ${theme.border}`}>
      <span className="shrink-0 text-xs">{theme.icon}</span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        {message && <p className="text-xs text-muted mt-0.5 leading-relaxed">{message}</p>}
      </div>
      <div className="ml-2 flex items-start gap-2 shrink-0">
        {retry && (
          <Button variant="ghost" size="sm" onClick={retry} className="text-[10px] text-accent">
            {retryLabel}
          </Button>
        )}
        {dismissible && onDismiss && (
          <button
            onClick={onDismiss}
            className="rounded-md p-1 text-muted hover:bg-white/10 dark:hover:bg-white/[0.05] transition"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ConfirmDialog
   ───────────────────────────────────────────── */
export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <Card padded={false} className="w-full max-w-md mx-auto shadow">
        <div className="p-5">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {message && <p className="text-xs text-muted mt-1 leading-relaxed">{message}</p>}
        </div>
        <div className="px-5 pb-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={variant} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </Card>
    </div>
  );
}
