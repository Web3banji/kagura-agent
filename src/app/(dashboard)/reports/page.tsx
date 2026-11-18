import Link from "next/link";
import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";

export const dynamic = "force-dynamic";

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Project reports built from real activity and evidence. Report generation is not yet implemented."
      />

      <Panel title="Reports" description="Reports will summarize real project activity and verification evidence for a chosen reporting period.">
        <ul className="space-y-3 text-sm text-muted">
          <li>
            <span className="font-medium text-fg">Planned report types:</span> daily updates, weekly summaries, development summaries, release notes, and milestone reports.
          </li>
          <li>
            <span className="font-medium text-fg">No fabricated data:</span> every report will use actual persisted activity and verification results only.
          </li>
        </ul>
      </Panel>

      <EmptyState
        title="No reports yet"
        detail="Report generation is not yet implemented. In the meantime, verification results are available on the Checks & tests page."
        action={<Link href="/verification" className="text-sm text-accent underline">View verification results →</Link>}
      />
    </div>
  );
}
