import { NextResponse } from "next/server";
import { discoverRepositories } from "@/lib/github/discover";
import { getRequestPrincipal, unauthorizedResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const principal = await getRequestPrincipal(req);
  if (!principal.authorized || principal.kind !== "user") {
    return unauthorizedResponse(principal.reason || "Unauthorized");
  }

  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const perPage = parseInt(url.searchParams.get("perPage") || "30", 10);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const owner = url.searchParams.get("owner")?.trim() || undefined;
    const visibility = (url.searchParams.get("visibility") as "all" | "public" | "private") || "all";
    const affiliation = (url.searchParams.get("affiliation") as "owner" | "collaborator" | "organization_member") || undefined;
    const includeArchived = url.searchParams.get("includeArchived") === "true";

    if (page < 1 || page > 1000) {
      return NextResponse.json({ error: "Invalid page parameter" }, { status: 400 });
    }
    if (perPage < 1 || perPage > 100) {
      return NextResponse.json({ error: "Invalid perPage parameter (max 100)" }, { status: 400 });
    }
    if (search && search.length > 200) {
      return NextResponse.json({ error: "Search query too long" }, { status: 400 });
    }
    if (owner && !/^[\w.-]+$/.test(owner)) {
      return NextResponse.json({ error: "Invalid owner parameter" }, { status: 400 });
    }

    const result = await discoverRepositories(principal.userId, {
      page,
      perPage,
      search,
      owner,
      visibility,
      affiliation,
      includeArchived,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to discover repositories";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}