import { NextResponse } from "next/server";
import { getCurrentPipelineState } from "@/lib/pipeline";
import { readRuns } from "@/lib/agent/runs";
import { getObservationStatus } from "@/lib/github/observe";

export const dynamic = "force-dynamic";

export async function GET() {
  const [state, runs, obs] = await Promise.all([
    getCurrentPipelineState(),
    readRuns(),
    getObservationStatus(),
  ]);
  return NextResponse.json({ state, runs: runs.slice(0, 10), observation: obs });
}