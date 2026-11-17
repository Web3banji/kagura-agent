import { NextResponse } from "next/server";
import { readJobs, enqueueJob, getJob } from "@/lib/verification/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (id) {
    const job = await getJob(id);
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ job });
  }
  const jobs = await readJobs();
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { flow?: string; objective?: string; url?: string; timeout?: number };
    const job = await enqueueJob({
      flow: body.flow || "shell-nav",
      objective: body.objective || "Shell navigation verification",
      url: body.url || process.env.KAGURA_APP_URL || (process.env.KAGURA_APP_URL || process.env.KAGURA_APP_URL) || "http://localhost:3000",
      timeout: body.timeout,
    });
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
