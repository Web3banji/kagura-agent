"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/command-center", label: "Command Center", hint: "State & pipeline" },
  { href: "/journal", label: "Agent Journal", hint: "Observed activity" },
  { href: "/verification", label: "Verification Lab", hint: "Kane runs" },
  { href: "/editorial", label: "Editorial Studio", hint: "Draft review" },
  { href: "/stories", label: "Published Stories", hint: "Public blog" },
  { href: "/settings", label: "Agent Settings", hint: "Configuration" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-full md:w-64 md:min-h-screen border-b md:border-b-0 md:border-r border-border bg-panel/60 backdrop-blur">
      <div className="px-5 py-5 border-b border-border">
        <Link href="/command-center" className="block">
          <div className="text-xs tracking-[0.2em] text-accent uppercase">ECHOLOG</div>
          <div className="mt-1 text-sm text-muted">Autonomous development journal</div>
        </Link>
      </div>
      <nav className="p-3 flex md:flex-col gap-1 overflow-x-auto">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              data-nav={item.label}
              className={`min-w-[180px] md:min-w-0 rounded-md px-3 py-2.5 transition border ${
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
        Pipeline: <span className="text-fg">OBSERVE → ANALYSE → VERIFY → WRITE → REVIEW → PUBLISH</span>
      </div>
    </aside>
  );
}