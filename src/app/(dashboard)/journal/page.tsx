import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { readJournalEvents } from "@/lib/journal/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { verificationToJournal } from "@/lib/journal/activity";
import { readObservedEvents } from "@/lib/github/store";
import { getObservationStatus } from "@/lib/github/observe";
import { resolveProjectId } from "@/lib/verification/context";
import Link from "next/link";

export const dynamic = "force-dynamic";

function eventKindLabel(type: string) {
  if (type === "commit") return "Project update";
  if (type === "observation") return "Check for changes";
  if (type === "verification") return "Test result";
  if (type === "decision") return "Note";
  return type;
}

export default async function JournalPage() {
  const projectId = await resolveProjectId();
  const [stored, verifications, observed, obsStatus] = await Promise.all([
    readJournalEvents(),
    readVerificationRecords({ projectId, includeLegacy: true }),
    readObservedEvents(),
    getObservationStatus(),
  ]);
  const verificationEvents = verifications.map(verificationToJournal);
  const events = [...stored, ...verificationEvents].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <div data-page="journal">
      <PageHeader
        title="Activity history"
        subtitle="A timeline of real project updates, checks, and test results. Nothing here is made up."
      />

      <Panel title="Project updates" description={`Changes found in ${obsStatus.repo}.`} className="mb-6">
        <div className="text-xs text-muted mb-3 flex flex-wrap gap-x-3 gap-y-1">
          <span>Connection: {obsStatus.tokenConfigured ? "Connected to GitHub" : "Checking locally"}</span>
          <span>Updates saved: {observed.length}</span>
          <span>Last looked: {obsStatus.state.lastObservedAt ? new Date(obsStatus.state.lastObservedAt).toLocaleString() : "never"}</span>
        </div>
        {obsStatus.state.lastError ? <p className="text-xs text-rose-300 mb-3">Last issue: {obsStatus.state.lastError}</p> : null}
        {observed.length === 0 ? (
          <EmptyState
            title="No project updates found yet"
            detail="Use “Check for changes” on the Home page (or in Settings) to look for recent updates. If nothing has changed in your project, nothing will appear here — and that’s okay."
            action={<Link href="/command-center" className="text-sm text-accent underline">Go to Home &amp; status</Link>}
          />
        ) : (
          <ul className="space-y-3">
            {observed.slice(0, 30).map((c) => (
              <li key={c.sha} className="rounded-lg border border-border bg-panel-2/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">{c.message}</div>
                    <div className="text-xs text-muted mt-1">
                      By {c.author} · {new Date(c.date).toLocaleString()}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border ${c.processed ? "border-border text-muted" : "border-accent/30 text-accent"}`}>
                    {c.processed ? "Already reviewed" : "New"}
                  </span>
                </div>
                {c.files?.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent">Show {c.files.length} changed file{c.files.length === 1 ? "" : "s"}</summary>
                    <ul className="mt-2 text-xs text-muted space-y-1">
                      {c.files.slice(0, 20).map((f, i) => (
                        <li key={i} className="flex flex-wrap gap-2">
                          <span className="font-mono text-fg/80">{f.filename}</span>
                          <span className="uppercase text-[10px] px-1.5 rounded border border-border">{f.status}</span>
                          {typeof f.additions === "number" ? <span className="text-emerald-300/80">+{f.additions}</span> : null}
                          {typeof f.deletions === "number" ? <span className="text-rose-300/80">-{f.deletions}</span> : null}
                        </li>
                      ))}
                      {c.files.length > 20 ? <li>…and {c.files.length - 20} more</li> : null}
                    </ul>
                  </details>
                ) : (
                  <div className="text-xs text-muted mt-2">No file details saved for this update.</div>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted">Technical details</summary>
                  <div className="mt-1 text-xs text-muted font-mono break-all space-y-1">
                    <div>ID: {c.shortSha} ({c.sha})</div>
                    {c.url ? <div><a className="text-accent underline" href={c.url} target="_blank" rel="noreferrer">View on GitHub</a></div> : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Timeline" description="Checks, tests, and notes in the order they happened (newest first).">
        {events.length === 0 ? (
          <EmptyState
            title="No activity yet"
            detail="When KAGURA checks for changes or runs a test, you’ll see it here with the time and result."
          />
        ) : (
          <ul className="space-y-3">
            {events.map((e) => (
              <li key={e.id} className="rounded-lg border border-border bg-panel-2/40 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
                  <span className="px-2 py-0.5 rounded border border-border text-accent">{eventKindLabel(e.type)}</span>
                  <span className="text-muted">{new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <div className="text-sm font-medium text-fg">{e.title}</div>
                <div className="text-sm text-muted mt-1 leading-relaxed">{e.summary}</div>
                {e.type === "verification" ? (
                  <div className="mt-2"><StatusBadge status={(e.title.split(":").pop() || "").trim() as Parameters<typeof StatusBadge>[0]["status"] || "none"} /></div>
                ) : null}
                {e.refs?.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted">Related details</summary>
                    <ul className="mt-1 text-xs text-muted break-all space-y-1">
                      {e.refs.map((r, i) => <li key={i} className="font-mono">{r}</li>)}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
