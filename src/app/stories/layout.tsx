import Link from "next/link";

export default function StoriesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-panel/60 backdrop-blur">
        <div className="max-w-4xl mx-auto px-5 md:px-8 py-5 flex items-center justify-between">
          <Link href="/stories" className="block">
            <div className="text-xs tracking-[0.2em] text-accent uppercase">ECHOLOG</div>
            <div className="text-sm text-muted">Published Stories</div>
          </Link>
          <Link href="/command-center" className="text-xs text-muted hover:text-fg border border-border rounded px-3 py-1.5">
            Command Center
          </Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-5 md:px-8 py-10">{children}</main>
    </div>
  );
}