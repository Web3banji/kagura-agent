import Image from "next/image";
import Link from "next/link";

export default function StoriesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-black/40 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-4 md:py-5 flex items-center justify-between gap-3">
          <Link href="/stories" className="block min-w-0 group">
            <div className="flex items-center gap-3">
              <Image src="/brand/chibi-wagasa-anime-emblem.png" alt="KAGURA logo" width={34} height={34} className="rounded-sm ring-1 ring-border-strong shadow-glow" />
              <div>
                <div className="font-tech text-[11px] tracking-[0.22em] text-accent uppercase">KAGURA</div>
                <div className="text-base text-fg font-semibold mt-0.5">Stories</div>
              </div>
            </div>
            <div className="text-xs text-muted hidden sm:block mt-2">Updates from real project work, reviewed before sharing.</div>
          </Link>
          <Link href="/command-center" className="font-tech text-[11px] uppercase tracking-[0.14em] text-muted hover:text-fg border border-border-strong rounded px-3 py-2 shrink-0 hover:border-accent/40">
            Dashboard
          </Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12">{children}</main>
    </div>
  );
}
