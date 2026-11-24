import { EmptyState } from "@/components/ui/Primitives";
import { readPublishedStories } from "@/lib/stories/store";
import { toPublicStory } from "@/lib/stories/public";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function StoriesPage() {
  const stories = (await readPublishedStories())
    .map(toPublicStory)
    .filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt).getTime() - new Date(a.publishedAt || a.updatedAt).getTime());

  return (
    <div data-page="stories">
      <h1 className="text-3xl font-semibold tracking-tight">Stories</h1>
      <p className="mt-2 text-muted max-w-2xl leading-relaxed">
        Short, honest updates about what changed in this project. Each story is based on real updates and (when available) real test results, and is reviewed before being shared.
      </p>
      <div className="mt-8">
        {stories.length === 0 ? (
          <EmptyState
            title="No stories published yet"
            detail="When a draft is reviewed and approved, it will appear here for everyone to read. If you manage this project, you can create and publish stories from the dashboard."
            action={<Link href="/command-center" className="text-sm text-accent underline">Open dashboard</Link>}
          />
        ) : (
          <ul className="space-y-4">
            {stories.map((s) => (
              <li key={s.slug} className="rounded-xl border border-border bg-panel/70 p-5">
                <div className="text-xs text-muted">
                  Published {s.publishedAt ? new Date(s.publishedAt).toLocaleString() : new Date(s.updatedAt).toLocaleString()}
                  {s.verification ? (
                    <span className="ml-2">· {s.verification.outcome === "passed" ? "Tested: looks good" : `Test result: ${s.verification.outcome.replace(/_/g, " ")}`}</span>
                  ) : (
                    <span className="ml-2">· Based on project updates</span>
                  )}
                </div>
                <Link href={`/stories/${s.slug}`} className="block mt-2">
                  <h2 className="text-xl font-semibold hover:text-accent transition-colors">{s.title}</h2>
                </Link>
                <p className="mt-2 text-sm text-muted leading-relaxed">{s.subtitle}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Link href={`/stories/${s.slug}`} className="text-sm text-accent underline">Read story →</Link>
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">Details</summary>
                    <div className="mt-1">{s.source.repo ? `Project: ${s.source.repo}` : null}{s.generationSource ? ` · Draft: ${s.generationSource === "ai" ? "written with AI help" : "written from template"}` : ""}</div>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
