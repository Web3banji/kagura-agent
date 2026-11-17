import { NextResponse } from "next/server";
import { observeGitHub } from "@/lib/github/observe";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await observeGitHub();
    if (result.error) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET() {
  const { getObservationStatus } = await import("@/lib/github/observe");
  return NextResponse.json(await getObservationStatus());
}