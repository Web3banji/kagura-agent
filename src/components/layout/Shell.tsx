"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ShellUser } from "../ui/elements";

type NavItem = {
  href: string;
  label: string;
  hint: string;
};

const WORKSPACE_NAV: NavItem[] = [
  { href: "/command-center", label: "Overview", hint: "What’s happening and what to do next" },
  { href: "/projects", label: "Projects", hint: "Your authorized projects" },
  { href: "/verification", label: "Verification", hint: "Checks and test results" },
  { href: "/reports", label: "Reports", hint: "Project reports" },
];

const MANAGE_NAV: NavItem[] = [
  { href: "/integrations", label: "Integrations", hint: "Connect project tools" },
  { href: "/settings", label: "Settings", hint: "Connections and preferences" },
];

export function Shell({
  children,
  currentUser = null,
}: {
  children: React.ReactNode;
  currentUser?: ShellUser;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const html = document.documentElement;
    const stored = localStorage.getItem("kagura-theme") as "light" | "dark" | null;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = stored === "dark" || (!stored && prefersDark) ? "dark" : "light";
    setTheme(next);
    if (next === "dark") html.classList.add("dark");
    else html.classList.remove("dark");
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("kagura-theme", next);
    const html = document.documentElement;
    if (next === "dark") html.classList.add("dark");
    else html.classList.remove("dark");
  };

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href + "/"));

  const signOut = () => {
    router.push("/api/auth/signout");
  };

  return (
    <div className="min-h-screen md:flex bg-transparent">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-border bg-panel/90 backdrop-blur-md flex flex-col transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } md:relative md:translate-x-0`}
        aria-label="Main navigation"
      >
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

        <nav className="p-3 flex flex-col gap-1">
          <h2 className="k-label mb-2">WORKSPACE</h2>
          {WORKSPACE_NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 border ${
                  active
                    ? "bg-accent/10 border-accent/35 text-fg shadow"
                    : "border-transparent hover:border-border-strong hover:bg-white/5 dark:hover:bg-white/[0.03] text-muted hover:text-fg"
                }`}
              >
                <div className="shrink-0">
                  <div className={`font-tech text-[10px] mt-0.5 ${active ? "text-accent" : "text-muted"}`}>
                    {WORKSPACE_NAV.indexOf(item) + 1}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-xs text-muted mt-0.5 leading-snug">{item.hint}</div>
                </div>
              </Link>
            );
          })}
          <h2 className="k-label mt-6 mb-2">MANAGE</h2>
          {MANAGE_NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 border ${
                  active
                    ? "bg-accent/10 border-accent/35 text-fg shadow"
                    : "border-transparent hover:border-border-strong hover:bg-white/5 dark:hover:bg-white/[0.03] text-muted hover:text-fg"
                }`}
              >
                <div className="shrink-0">
                  <div className={`font-tech text-[10px] mt-0.5 ${active ? "text-accent" : "text-muted"}`}>
                    {WORKSPACE_NAV.length + MANAGE_NAV.indexOf(item) + 1}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-xs text-muted mt-0.5 leading-snug">{item.hint}</div>
                </div>
              </Link>
            );
          })}
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
            <Button variant="ghost" size="sm" onClick={signOut} className="text-[10px] w-auto px-2 py-1.5">
              Sign out
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={toggleTheme} className="text-[10px] w-auto px-2 py-1.5">
              {theme === "light" ? "Dark mode" : "Light mode"}
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 dark:bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Top bar (mobile) */}
      <header className="md:hidden sticky top-0 z-20 border-b border-border bg-panel/80 backdrop-blur-md px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded-md p-1.5 text-muted hover:bg-white/10 dark:hover:bg-white/[0.05]"
          aria-label="Open navigation"
        >
          ☰
        </button>
        <Link href="/command-center" className="flex items-center gap-2">
          <Image src="/brand/chibi-wagasa-anime-emblem.png" alt="KAGURA logo" width={26} height={26} className="rounded-sm ring-1 ring-border-strong" />
          <span className="font-tech text-xs tracking-[0.22em] text-accent uppercase">KAGURA</span>
        </Link>
        <div className="flex items-center gap-2">
        </div>
      </header>

      <main className="flex-1 min-w-0 md:ml-0">
        <div className="max-w-[1240px] mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-10">{children}</div>
      </main>
    </div>
  );
}
