"use client";

import Image from "next/image";
import Link from "next/link";
import { Sidebar } from "./Sidebar";
import { useEffect, useState } from "react";
import { Button } from "../ui/elements";

type ShellUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  githubLogin?: string | null;
  isBootstrapOwner?: boolean;
} | null;

export function AppShell({
  children,
  currentUser = null,
}: {
  children: React.ReactNode;
  currentUser?: ShellUser;
}) {
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

  return (
    <div className="min-h-screen md:flex bg-transparent">
      <Sidebar currentUser={currentUser} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden sticky top-0 z-20 border-b border-border bg-panel/80 backdrop-blur-md px-4 py-3 flex items-center justify-between">
          <button
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
            <Link href="/stories" className="font-tech text-[11px] uppercase tracking-[0.14em] text-muted hover:text-fg border border-border rounded px-2 py-1">
              Stories
            </Link>
            <Button variant="ghost" size="sm" onClick={toggleTheme} className="text-[10px] w-auto px-2 py-1.5">
              {theme === "light" ? "Dark mode" : "Light mode"}
            </Button>
            {currentUser ? (
              <form action="/api/auth/signout" method="post">
                <Button variant="ghost" size="sm" type="submit" className="text-[10px] w-auto px-2 py-1.5">
                  Sign out
                </Button>
              </form>
            ) : null}
          </div>
        </header>
        <main className="flex-1 min-w-0">
          <div className="max-w-[1240px] mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
