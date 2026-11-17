import { EmptyState, PageHeader, Panel } from "@/components/ui/Primitives";
import { getRecentLocalCommits } from "@/lib/journal/activity";
import { readJournalEvents } from "@/lib/journal/store";
import { readVerificationRecords } from "@/lib/verification/store";
import { verificationToJournal } from "@/lib/journal/activity";

export const dynamic = "force-dynamic";

export default async function JournalPage() {
  const stored = await readJournalEvents();
  const commits = await getRecentLocalCommits(20);
  const verifications = (await readVerificationRecords()).map(verificationToJournal);
  const events = [...stored, ...verifications, ...commits].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <div data-page="journal">
      <PageHeader
        title="Agent Journal"
        subtitle="Foundation for recording actual GitHub development events, milestones, and verification history. No fabricated entries."
      />
      <Panel title="Observed events">
        {events.length === 0 ? (
          <EmptyState
            title="No journal events yet"
            detail="This journal only records real observed activity (commits, verification runs, agent decisions). Nothing has been recorded or fabricated."
          />
        ) : (
          <ul className="space-y-3">
            {events.map((e) => (
              <li key={e.id} className="rounded-lg border border-border bg-panel-2/40 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted mb-1">
                  <span className="uppercase tracking-wide text-accent">{e.type}</span>
                  <span>·</span>
                  <span>{e.source}</span>
                  <span>·</span>
                  <span className="font-mono">{new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <div className="text-sm font-medium">{e.title}</div>
                <div className="text-sm text-muted mt-1">{e.summary}</div>
                {e.refs?.length ? (
                  <div className="mt-2 text-xs text-muted break-all">Refs: {e.refs.join(" | ")}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}