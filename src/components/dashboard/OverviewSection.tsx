import Link from "next/link";
import { PageHeader } from "@/components/ui/Primitives";

const SECTIONS = [
  {
    href: "/projects",
    title: "Projects",
    description: "Add, manage and select the projects you want to verify.",
    icon: "M3 7h18M3 7l2-3h14l2 3M5 7v12h14V7M9 11h6",
  },
  {
    href: "/verification",
    title: "Verification",
    description: "Run verification checks with KANE, monitor progress and inspect detected issues.",
    icon: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  },
  {
    href: "/reports",
    title: "Reports",
    description: "Access documented verification results, generate AI-assisted reports and retrieve prompts for fixing identified issues.",
    icon: "M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4",
  },
  {
    href: "/settings",
    title: "Settings",
    description: "Manage your application configuration and preferences.",
    icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-3-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 3 2 1v2l-2 1 2 3 2-1 2 1 1 2h4l1-2 2-1 2 1 2-3-2-1z",
  },
];

export default function OverviewSection() {
  return (
    <div className="space-y-8" data-page="overview">
      <PageHeader
        eyebrow="KAGURA"
        title="Welcome to KAGURA"
        subtitle="A focused workspace for verifying projects, understanding issues, and producing clear reports."
      />

      <section className="rounded-2xl border border-border/80 bg-panel/70 p-6 md:p-8 shadow-soft">
        <div className="max-w-3xl">
          <div className="k-label text-accent/90 mb-3">What KAGURA does</div>
          <p className="text-lg md:text-xl font-medium text-fg leading-relaxed text-balance">
            KAGURA helps developers verify their projects, identify issues, understand what needs fixing, and generate clear reports from their verification results.
          </p>
          <p className="mt-4 text-sm md:text-base text-muted leading-relaxed">
            Powered by KANE, its verification engine, KAGURA helps developers understand the state of their projects and take informed action when issues are detected.
          </p>
        </div>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight text-fg">Where to go</h2>
          <p className="mt-1 text-sm text-muted">Choose the part of KAGURA that matches what you want to do.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {SECTIONS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="group rounded-xl border border-border/80 bg-panel/60 p-5 transition hover:border-accent/40 hover:bg-panel/90 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <div className="flex items-start gap-4">
                <div className="shrink-0 rounded-lg border border-accent/25 bg-accent-soft/10 p-2.5 text-accent">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={section.icon} />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-fg group-hover:text-accent">{section.title}</div>
                  <p className="mt-1 text-sm text-muted leading-relaxed">{section.description}</p>
                  <span className="mt-3 inline-block text-xs font-tech uppercase tracking-[0.14em] text-accent">Open {section.title}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}