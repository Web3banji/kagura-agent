import { EmptyState } from "@/components/ui/Primitives";

export default function StoriesPage() {
  return (
    <div data-page="stories">
      <h1 className="text-3xl font-semibold tracking-tight">Stories</h1>
      <p className="mt-2 text-muted max-w-2xl">
        Factual, evidence-grounded articles about ECHOLOG&apos;s own evolution. Only owner-approved, verified stories are published.
      </p>
      <div className="mt-8">
        <EmptyState
          title="No published stories yet"
          detail="The blog is ready for real, approved articles. Until an article is generated from verified development evidence and published, nothing will appear here."
        />
      </div>
    </div>
  );
}