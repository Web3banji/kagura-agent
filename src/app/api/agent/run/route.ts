import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/agent/pipeline";
import { getActiveRun } from "@/lib/agent/runs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    const active = await getActiveRun();
    if (active) {
      return NextResponse.json({ error: "An agent run is already in progress.", run: active }, { status: 409 });
    }
    const result = await runPipeline("manual");
    if (result.error && !result.run) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}