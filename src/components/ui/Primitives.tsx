import { PIPELINE_STEPS } from "@/lib/ui-text";

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow = "KAGURA / Console",
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between mb-7 md:mb-10 pb-5 border-b border-border/80">
      <div className="min-w-0">
        <div className="k-label mb-2 text-accent/90">{eyebrow}</div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm md:text-[15px] text-muted max-w-3xl leading-relaxed">{subtitle}</p> : null}
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
    <section className={`relative overflow-hidden rounded-xl border border-border/90 bg-panel/80 backdrop-blur-sm shadow-soft p-4 md:p-5 ${className}`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
      {title ? <h2 className="text-[13px] font-tech uppercase tracking-[0.14em] text-fg/95">{title}</h2> : null}
      {description ? <p className="mt-1.5 text-xs text-muted leading-relaxed">{description}</p> : null}
      <div className={title || description ? "mt-4" : ""}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-panel-2/30 p-5 md:p-7 text-center">
      <div className="k-label mb-2 text-accent/70">Empty</div>
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="mt-2 text-sm text-muted leading-relaxed max-w-xl mx-auto">{detail}</div>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
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
            className={`rounded-lg border px-2.5 py-2.5 text-left transition ${
              active
                ? "border-accent/50 bg-accent-soft shadow-glow"
                : past
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-border bg-panel-2/20"
            }`}
            title={s.detail}
          >
            <div className="k-label !text-[10px]">Step {String(i + 1).padStart(2, "0")}</div>
            <div className={`text-xs font-medium mt-1 ${active ? "text-accent" : "text-fg"}`}>{s.label}</div>
            {!compact ? <div className="text-[11px] text-muted mt-1 leading-snug">{s.detail}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}