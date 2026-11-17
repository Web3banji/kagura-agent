import { NextResponse } from "next/server";
import { readGitHubConfig, writeGitHubConfig } from "@/lib/github/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readGitHubConfig());
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { owner?: string; repo?: string };
    const owner = (body.owner || "").trim();
    const repo = (body.repo || "").trim();
    if (!owner || !repo) return NextResponse.json({ error: "owner and repo are required" }, { status: 400 });
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      return NextResponse.json({ error: "Invalid owner or repo name" }, { status: 400 });
    }
    const cfg = await writeGitHubConfig(owner, repo);
    return NextResponse.json(cfg);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}