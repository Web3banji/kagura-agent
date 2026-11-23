import Link from "next/link";
import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";
import { readStories } from "@/lib/stories/store";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const stories = await readStories(scope);
  const published = stories.filter((s) => s.status === "published");

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="Published reports built from real project activity and verification evidence." />
      <Panel title={`Published reports (${published.length})`}>
        {published.length === 0 ? (
          <EmptyState title="No published reports yet" detail="Approved drafts from Intelligence will appear here." action={<Link href="/editorial" className="text-sm text-accent underline">Open Intelligence</Link>} />
        ) : (
          <ul className="space-y-3">
            {published.map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-panel-2/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/stories/${s.slug}`} className="text-sm font-medium text-fg hover:text-accent">{s.title}</Link>
                    <div className="text-xs text-muted mt-1">{s.publishedAt ? new Date(s.publishedAt).toLocaleString() : ""}</div>
                  </div>
                  <Link className="text-accent text-xs underline shrink-0" href={`/stories/${s.slug}`}>Read</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
