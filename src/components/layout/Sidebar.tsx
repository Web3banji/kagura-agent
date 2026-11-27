"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "../ui/elements";

const NAV = [
  { href: "/command-center", label: "Overview", hint: "What KAGURA is and how to start" },
  { href: "/projects", label: "Projects", hint: "Your authorized projects" },
  { href: "/verification", label: "Verification", hint: "Checks and test results" },
  { href: "/reports", label: "Reports", hint: "Verification report library" },
  { href: "/settings", label: "Settings", hint: "Account and preferences" },
];

type ShellUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  githubId?: string | null;
  githubLogin?: string | null;
  isBootstrapOwner?: boolean;
} | null;

export function Sidebar({ currentUser = null }: { currentUser?: ShellUser }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(href + "/"));

  const renderNav = (items: typeof NAV, offset: number) =>
    items.map((item, index) => {
      const active = isActive(item.href);
      return (
        <Link
          key={item.href}
          href={item.href}
          className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 border ${
            active
              ? "bg-accent/10 border-accent/35 text-fg shadow"
              : "border-transparent hover:border-border-strong hover:bg-white/5 dark:hover:bg-white/[0.03] text-muted hover:text-fg"
          }`}
        >
          <div className="shrink-0">
            <div className={`font-tech text-[10px] mt-0.5 ${active ? "text-accent" : "text-muted"}`}>
              {offset + index + 1}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{item.label}</div>
            <div className="text-xs text-muted mt-0.5 leading-snug">{item.hint}</div>
          </div>
        </Link>
      );
    });

  return (
    <aside className="w-full md:w-72 border-r border-border bg-panel/90 backdrop-blur-md flex flex-col">
      <div className="px-5 py-4 border-b border-border">
        <Link href="/command-center" className="block group">
          <div className="flex items-center gap-3">
            <Image
              src="/brand/chibi-wagasa-anime-emblem.png"
              alt="KAGURA logo"
              width={40}
              height={40}
              className="rounded-md ring-1 ring-border-strong shadow"
              priority
            />
            <div>
              <div className="font-tech text-xs tracking-[0.24em] text-accent uppercase">KAGURA</div>
              <div className="mt-0.5 text-sm text-fg font-semibold tracking-tight">Project Workspace</div>
            </div>
          </div>
        </Link>
      </div>

      <nav className="p-3 flex flex-col gap-1" aria-label="Main navigation">
        <h2 className="k-label mb-2">WORKSPACE</h2>
        {renderNav(NAV, 0)}
        
        
      </nav>

      <div className="p-4 mt-auto border-t border-border">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <div className="text-[11px] text-fg/90 truncate">
              {currentUser?.name || currentUser?.githubLogin || currentUser?.email || "Signed in"}
            </div>
            {currentUser?.githubLogin ? (
              <div className="text-[11px] text-muted truncate">@{currentUser.githubLogin}</div>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = "/api/auth/signout";
            }}
            className="text-[10px] w-auto px-2 py-1.5"
          >
            Sign out
          </Button>
        </div>
      </div>
    </aside>
  );
}


