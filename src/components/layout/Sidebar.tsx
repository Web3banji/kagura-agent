"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/command-center", label: "Home & status", hint: "See what’s happening and start a run", code: "01" },
  { href: "/journal", label: "Activity history", hint: "Recent changes and events", code: "02" },
  { href: "/verification", label: "Checks & tests", hint: "See if things were tested and results", code: "03" },
  { href: "/editorial", label: "Review drafts", hint: "Edit, approve, or publish stories", code: "04" },
  { href: "/stories", label: "Published stories", hint: "Stories visitors can read", code: "05" },
  { href: "/settings", label: "Settings", hint: "Connections and setup", code: "06" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-full md:w-72 md:min-h-screen border-b md:border-b-0 md:border-r border-border bg-black/30 backdrop-blur-md md:sticky md:top-0 flex flex-col">
      <div className="px-5 py-4 md:py-6 border-b border-border">
        <Link href="/command-center" className="block group">
          <div className="flex items-center gap-3">
            <Image
              src="/brand/chibi-wagasa-anime-emblem.png"
              alt="KAGURA logo"
              width={40}
              height={40}
              className="rounded-md ring-1 ring-border-strong shadow-glow"
              priority
            />
            <div>
              <div className="font-tech text-xs tracking-[0.24em] text-accent uppercase">KAGURA</div>
              <div className="mt-0.5 text-sm text-fg font-semibold tracking-tight">Project story system</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted leading-relaxed">Observe, verify, and publish what’s real — nothing invented.</div>
        </Link>
      </div>
      <nav className="p-3 flex md:flex-col gap-1.5 overflow-x-auto" aria-label="Main navigation">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              data-nav={item.label}
              className={`relative min-w-[200px] md:min-w-0 rounded-lg px-3 py-2.5 transition border ${
                active
                  ? "bg-accent/10 border-accent/35 text-fg shadow-glow"
                  : "border-transparent hover:border-border-strong hover:bg-white/[0.03] text-muted hover:text-fg"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span className={`font-tech text-[10px] mt-0.5 ${active ? "text-accent" : "text-muted"}`}>{item.code}</span>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-xs text-muted mt-0.5 leading-snug">{item.hint}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="hidden md:block p-4 mt-auto text-xs text-muted border-t border-border">
        <div className="k-label text-accent/80 mb-2">Pipeline</div>
        <p className="leading-relaxed">Check for changes → understand → test → write → you review → publish.</p>
      </div>
    </aside>
  );
}