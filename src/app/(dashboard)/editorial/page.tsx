import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";
import { readStories } from "@/lib/stories/store";
import { getServerPrincipal, principalHasLegacyAccess } from "@/lib/auth/guards";
import { scopeForPrincipal } from "@/lib/auth/scope";
import { aiConfigured } from "@/lib/ai/provider";
import Link from "next/link";
import { DraftActions } from "./draft-actions";

export const dynamic = "force-dynamic";

export default async function EditorialPage() {
  const principal = await getServerPrincipal();
  const scope = scopeForPrincipal(principal, { legacyAccess: principalHasLegacyAccess(principal) });
  const stories = await readStories(scope);
  const drafts = stories.filter((s) => s.status === "review" || s.status === "draft");
  const rejected = stories.filter((s) => s.status === "rejected");
  const published = stories.filter((s) => s.status === "published");
  const ai = aiConfigured();

  return (
    <div data-page="editorial">
      <PageHeader
        title="Review drafts"
        subtitle="Read, edit, and decide what to share. Approve a draft to publish it as a story — nothing is published without your approval."
      />

      <Panel title="How publishing works" className="mb-6">
        <ol className="grid gap-2 sm:grid-cols-3 text-sm text-muted">
          <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">1. A draft is created</span><div className="mt-1 text-xs">After a check, KAGURA can write a draft based on real updates and test results.</div></li>
          <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">2. You review and edit</span><div className="mt-1 text-xs">Make changes, save them, or write a new draft. You can also discard it.</div></li>
          <li className="rounded-lg border border-border bg-panel-2/40 p-3"><span className="text-fg font-medium">3. Approve &amp; publish</span><div className="mt-1 text-xs">When it looks right, publish it so it appears on the <Link href="/stories" className="text-accent underline">Published stories</Link> page.</div></li>
        </ol>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <Panel title="Draft writing">
          <div className="text-sm text-fg">{ai.configured ? "AI writing help is connected" : "Using a simple built-in draft"}</div>
          <p className="text-xs text-muted mt-1">
            {ai.configured
              ? `Drafts can be written with help from ${ai.provider}.`
              : "AI writing is not connected, so drafts are written from a clear template using real evidence."}
          </p>
          <p className="text-xs text-muted mt-2">Drafts are always based on real project updates and test results — never made up.</p>
        </Panel>
        <Panel title="Ready to review"><div className="text-2xl font-semibold">{drafts.length}</div><p className="text-xs text-muted mt-1">Draft{drafts.length === 1 ? "" : "s"} waiting for your decision.</p></Panel>
        <Panel title="Published"><div className="text-2xl font-semibold text-emerald-300">{published.length}</div><p className="text-xs text-muted mt-1">Stor{published.length === 1 ? "y" : "ies"} shared publicly.</p></Panel>
      </div>

      <Panel title={`Drafts ready for your review (${drafts.length})`} description="Edit the text, save your changes, then approve & publish — or discard the draft.">
        {drafts.length === 0 ? (
          <EmptyState
            title="No drafts to review right now"
            detail="When KAGURA finds new updates and creates a draft, it will appear here for you to review. You can start a check from the Home page."
            action={<Link href="/command-center" className="text-sm text-accent underline">Go to Home &amp; status</Link>}
          />
        ) : (
          <ul className="space-y-4">
            {drafts.map((s) => (
              <li key={s.id}><DraftActions story={s} /></li>
            ))}
          </ul>
        )}
      </Panel>

      {rejected.length > 0 ? (
        <Panel title={`Discarded drafts (${rejected.length})`} className="mt-4">
          <p className="text-xs text-muted mb-3">These drafts were removed from review and were not published.</p>
          <ul className="text-sm space-y-2">
            {rejected.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-2 last:border-0">
                <div className="min-w-0">
                  <div className="font-medium text-fg">{s.title}</div>
                  <div className="text-xs text-muted">Discarded {s.rejectedAt ? new Date(s.rejectedAt).toLocaleString() : ""}</div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title={`Published stories (${published.length})`} className="mt-4">
        {published.length === 0 ? (
          <p className="text-sm text-muted">No stories published yet. Approved drafts will appear here and on the public Stories page.</p>
        ) : (
          <ul className="text-sm space-y-2">
            {published.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-2 last:border-0">
                <div className="min-w-0">
                  <div className="font-medium text-fg">{s.title}</div>
                  <div className="text-xs text-muted">{s.publishedAt ? new Date(s.publishedAt).toLocaleString() : ""}</div>
                </div>
                <Link className="text-accent text-xs underline shrink-0" href={`/stories/${s.slug}`}>View story</Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
