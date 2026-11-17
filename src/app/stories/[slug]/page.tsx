import { getStoryBySlug, readStories } from "@/lib/stories/store";
import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
  const stories = (await readStories()).filter((s) => s.status === "published");
  return stories.map((s) => ({ slug: s.slug }));
}

export default async function StoryPage({ params }: { params: { slug: string } }) {
  const story = await getStoryBySlug(params.slug);
  if (!story || story.status !== "published") notFound();

  const published = story.publishedAt
    ? new Date(story.publishedAt).toLocaleString()
    : new Date(story.updatedAt).toLocaleString();

  return (
    <article data-page="story-detail">
      <Link href="/stories" className="text-sm text-accent underline">← Back to all stories</Link>
      <div className="mt-4 text-xs text-muted">
        Published {published}
        {story.verification ? (
          <span className="ml-2">· {story.verification.outcome === "passed" ? "Tested: looks good" : `Test result: ${story.verification.outcome.replace(/_/g, " ")}`}</span>
        ) : (
          <span className="ml-2">· Based on project updates</span>
        )}
      </div>
      <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">{story.title}</h1>
      <p className="mt-3 text-lg text-muted leading-relaxed">{story.subtitle}</p>

      <div className="mt-8">
        <pre className="whitespace-pre-wrap font-sans text-sm md:text-base leading-7 text-fg/90 bg-transparent p-0 m-0">
          {story.body}
        </pre>
      </div>

      <section className="mt-10 rounded-xl border border-border bg-panel/70 p-5">
        <h2 className="text-sm font-medium mb-2 text-fg">How this story was put together</h2>
        <p className="text-xs text-muted mb-3 leading-relaxed">This story is based on real project updates and (when available) real test results. You can view the details below for transparency.</p>
        <div className="text-sm text-muted space-y-2">
          <div><span className="text-fg/80 font-medium">Summary of what was observed:</span> {story.source.observationSummary}</div>
          <div>
            <div className="text-fg/80 font-medium mb-1">Project updates included:</div>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {story.source.commits.map((c) => (
                <li key={c.sha}>
                  {c.message}
                  <span className="text-xs text-muted">{c.date ? ` — ${new Date(c.date).toLocaleString()}` : ""}{c.author ? ` by ${c.author}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
          {story.verification ? (
            <div className="rounded-lg border border-border bg-panel-2/40 p-3">
              <div className="text-fg/80 font-medium">Test result</div>
              <div className="mt-1 text-sm">{story.verification.outcome === "passed" ? "Looks good — the test finished with no problems found." : `Result: ${story.verification.outcome.replace(/_/g, " ")}`}{story.verification.summary ? ` ${story.verification.summary}` : ""}</div>
              {story.verification.failingStep ? <div className="mt-1 text-sm text-rose-300">Where it went wrong: {story.verification.failingStep}</div> : null}
            </div>
          ) : (
            <div className="text-sm text-muted">No test was attached to this story.</div>
          )}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-accent">Technical details</summary>
          <div className="mt-2 text-xs text-muted space-y-1 break-all">
            {story.source.repo ? <div>Project: {story.source.repo}</div> : null}
            {story.source.observationSource ? <div>Update source: {story.source.observationSource === "github-api" ? "GitHub" : "Local project history"}</div> : null}
            <div>Update IDs: {story.source.commits.map((c) => c.sha.slice(0, 7)).join(", ")}</div>
            {story.source.changedFiles?.length ? <div>Files changed: {story.source.changedFiles.join(", ")}</div> : null}
            {story.verification ? (
              <>
                <div>Test outcome: {story.verification.outcome} (code {story.verification.exitCode ?? "n/a"})</div>
                {typeof story.verification.durationMs === "number" ? <div>Duration: {(story.verification.durationMs / 1000).toFixed(1)}s</div> : null}
                {story.verification.testUrl ? <div>Full test report: <a className="text-accent underline" href={story.verification.testUrl} target="_blank" rel="noreferrer">{story.verification.testUrl}</a></div> : null}
                {story.verification.evidencePath ? <div>Evidence: {story.verification.evidencePath}</div> : null}
                {story.verification.ndjsonPath ? <div>Run log: {story.verification.ndjsonPath}</div> : null}
              </>
            ) : null}
          </div>
        </details>
      </section>

      <div className="mt-8">
        <Link href="/stories" className="text-sm text-accent underline">← Back to all stories</Link>
      </div>
    </article>
  );
}
