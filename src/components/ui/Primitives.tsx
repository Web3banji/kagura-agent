import { PIPELINE_STEPS } from "@/lib/ui-text";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between mb-6 md:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm text-muted max-w-2xl">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-border bg-panel/70 shadow-soft p-4 md:p-5 ${className}`}>
      {title ? <h2 className="text-sm font-medium text-fg">{title}</h2> : null}
      {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      <div className={title || description ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-panel-2/40 p-5 md:p-6">
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="mt-1 text-sm text-muted leading-relaxed">{detail}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function WorkflowStrip({ current, compact = false }: { current?: string; compact?: boolean }) {
  return (
    <ol className={`grid gap-2 ${compact ? "grid-cols-3 md:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-6"}`} aria-label="How KAGURA works">
      {PIPELINE_STEPS.map((s, i) => {
        const active = current === s.id;
        const past = current ? PIPELINE_STEPS.findIndex((x) => x.id === current) > i : false;
        return (
          <li
            key={s.id}
            className={`rounded-lg border px-2.5 py-2 text-left ${
              active
                ? "border-accent/50 bg-accent-soft"
                : past
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-border bg-panel-2/30"
            }`}
            title={s.detail}
          >
            <div className="text-[11px] text-muted">Step {i + 1}</div>
            <div className={`text-xs font-medium mt-0.5 ${active ? "text-accent" : "text-fg"}`}>{s.label}</div>
            {!compact ? <div className="text-[11px] text-muted mt-1 leading-snug">{s.detail}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}