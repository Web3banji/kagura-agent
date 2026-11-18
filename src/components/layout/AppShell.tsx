import Image from "next/image";
import Link from "next/link";
import { Sidebar } from "./Sidebar";

type ShellUser = { name?: string | null; email?: string | null; githubLogin?: string | null } | null;

export function AppShell({
  children,
  currentUser = null,
  adminTokenAccess = false,
}: {
  children: React.ReactNode;
  currentUser?: ShellUser;
  adminTokenAccess?: boolean;
}) {
  return (
    <div className="min-h-screen md:flex bg-transparent">
      <Sidebar currentUser={currentUser} adminTokenAccess={adminTokenAccess} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden sticky top-0 z-20 border-b border-border bg-black/50 backdrop-blur-md px-4 py-3 flex items-center justify-between">
          <Link href="/command-center" className="flex items-center gap-2.5">
            <Image src="/brand/chibi-wagasa-anime-emblem.png" alt="KAGURA logo" width={28} height={28} className="rounded-sm ring-1 ring-border-strong" />
            <span className="font-tech text-xs tracking-[0.22em] text-accent uppercase">KAGURA</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/stories" className="font-tech text-[11px] uppercase tracking-[0.14em] text-muted hover:text-fg border border-border rounded px-2.5 py-1.5">Stories</Link>
            {currentUser ? (
              <form action="/api/auth/signout" method="post">
                <button type="submit" className="font-tech text-[11px] uppercase tracking-[0.14em] text-muted hover:text-fg border border-border rounded px-2.5 py-1.5">Sign out</button>
              </form>
            ) : null}
          </div>
        </header>
        <main className="flex-1 min-w-0">
          <div className="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-10 py-6 md:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}