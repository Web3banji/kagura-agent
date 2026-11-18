import Link from "next/link";
import { PageHeader, Panel, EmptyState } from "@/components/ui/Primitives";

export const dynamic = "force-dynamic";

export default function TeamPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        subtitle="Workspace members and access. Multi-user data isolation is enforced server-side; member management UI is not yet implemented."
      />

      <Panel title="Team access" description="KAGURA enforces per-user ownership of stories, runs, and verification records. Every record is scoped to the user who created it.">
        <ul className="space-y-3 text-sm text-muted">
          <li>
            <span className="font-medium text-fg">Data isolation:</span> ordinary users see only their own records; bootstrap owners and administrators see workspace-wide records.
          </li>
          <li>
            <span className="font-medium text-fg">No member management yet:</span> inviting teammates, assigning roles, and shared project access are not yet available in the UI.
          </li>
          <li>
            <span className="font-medium text-fg">Server-side enforcement:</span> all reads and writes are authorized against the authenticated principal, so the UI never needs to trust the client for access control.
          </li>
        </ul>
      </Panel>

      <EmptyState
        title="No team members to manage"
        detail="Team collaboration features (invitations, roles, shared projects) are planned. Until then, each user has their own isolated workspace."
        action={<Link href="/settings" className="text-sm text-accent underline">Open Settings →</Link>}
      />
    </div>
  );
}
