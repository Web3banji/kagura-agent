"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/command-center", label: "Home & status", hint: "See what’s happening and start a run" },
  { href: "/journal", label: "Activity history", hint: "Recent changes and events" },
  { href: "/verification", label: "Checks & tests", hint: "See if things were tested and results" },
  { href: "/editorial", label: "Review drafts", hint: "Edit, approve, or publish stories" },
  { href: "/stories", label: "Published stories", hint: "Stories visitors can read" },
  { href: "/settings", label: "Settings", hint: "Connections and setup" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-full md:w-64 md:min-h-screen border-b md:border-b-0 md:border-r border-border bg-panel/60 backdrop-blur">
      <div className="px-5 py-4 md:py-5 border-b border-border">
        <Link href="/command-center" className="block">
          <div className="text-xs tracking-[0.2em] text-accent uppercase">KAGURA</div>
          <div className="mt-1 text-sm text-fg font-medium">Project story helper</div>
          <div className="mt-0.5 text-xs text-muted">Turns real project updates into stories you can review and share.</div>
        </Link>
      </div>
      <nav className="p-3 flex md:flex-col gap-1 overflow-x-auto" aria-label="Main navigation">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              data-nav={item.label}
              className={`min-w-[190px] md:min-w-0 rounded-md px-3 py-2.5 transition border ${
                active
                  ? "bg-accent-soft border-accent/30 text-fg"
                  : "border-transparent hover:border-border hover:bg-panel-2 text-muted hover:text-fg"
              }`}
            >
              <div className="text-sm font-medium">{item.label}</div>
              <div className="text-xs text-muted mt-0.5">{item.hint}</div>
            </Link>
          );
        })}
      </nav>
      <div className="hidden md:block p-4 mt-auto text-xs text-muted border-t border-border">
        <div className="font-medium text-fg/90 mb-1">How it works</div>
        <p>Check for changes → understand → test → write → you review → publish.</p>
      </div>
    </aside>
  );
}