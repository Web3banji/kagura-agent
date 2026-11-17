import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";

export default function EditorialPage() {
  return (
    <div data-page="editorial">
      <PageHeader
        title="Editorial Studio"
        subtitle="Foundation for reviewing, editing, and approving generated articles grounded in verified evidence."
      />
      <Panel title="Drafts">
        <EmptyState
          title="No drafts available"
          detail="No articles have been generated. Drafts will appear here only when produced from real observed development activity and verification evidence. No fabricated articles exist."
        />
      </Panel>
      <Panel title="Editorial controls (foundation)" className="mt-4">
        <ul className="text-sm text-muted space-y-2">
          <li>• Generate draft from observed, verified changes — <span className="text-warning">not yet connected</span></li>
          <li>• Edit / rewrite / regenerate with evidence references — <span className="text-warning">pending pipeline</span></li>
          <li>• Approve for publishing — <span className="text-warning">pending pipeline</span></li>
        </ul>
        <p className="mt-3 text-xs text-muted">Controls will be enabled only when backed by real data and integrations. No fabricated content can be created here.</p>
      </Panel>
    </div>
  );
}