import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { deleteRepositoryConnection, getRepositoryConnectionForUser } from "@/lib/repositories/connections";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }

  try {
    const { id } = await params;
    const connectionId = id.trim();

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID is required" }, { status: 400 });
    }

    const connection = await getRepositoryConnectionForUser(connectionId, principal.userId);
    if (!connection) {
      return NextResponse.json({ error: "Repository connection not found" }, { status: 404 });
    }

    const deleted = await deleteRepositoryConnection(connectionId, principal.userId);
    if (!deleted) {
      const pgErr = new Error("Delete failed") as { code?: string };
      if (pgErr.code === "23001") {
        return NextResponse.json(
          { error: "Cannot disconnect repository: it is linked to one or more projects. Unlink from all projects first." },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Failed to disconnect repository" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23001") {
      return NextResponse.json(
        { error: "Cannot disconnect repository: it is linked to one or more projects. Unlink from all projects first." },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : "Failed to disconnect repository";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}