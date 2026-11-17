import Link from "next/link";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen md:flex">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden border-b border-border bg-panel/60 backdrop-blur px-4 py-2 flex items-center justify-between">
          <Link href="/command-center" className="text-xs tracking-[0.2em] text-accent uppercase font-medium">KAGURA</Link>
          <Link href="/stories" className="text-xs text-muted hover:text-fg border border-border rounded px-2.5 py-1">View stories</Link>
        </header>
        <main className="flex-1 min-w-0">
          <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}