import Link from "next/link";

export default function StoriesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-panel/60 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-4 md:py-5 flex items-center justify-between gap-3">
          <Link href="/stories" className="block min-w-0">
            <div className="text-xs tracking-[0.2em] text-accent uppercase">KAGURA</div>
            <div className="text-sm text-fg font-medium">Stories</div>
            <div className="text-xs text-muted hidden sm:block">Updates from real project work, reviewed before sharing.</div>
          </Link>
          <Link href="/command-center" className="text-xs text-muted hover:text-fg border border-border rounded px-3 py-1.5 shrink-0">
            Open dashboard
          </Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-10">{children}</main>
    </div>
  );
}
