import { NextResponse } from "next/server";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";
import { listRepositoryConnectionsForUser } from "@/lib/repositories/connections";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }

  try {
    const connections = await listRepositoryConnectionsForUser(principal.userId);
    return NextResponse.json({ connections });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list repository connections";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}