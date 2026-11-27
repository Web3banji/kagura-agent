import { NextResponse } from "next/server";
import { GET as agentGET, POST as agentPOST } from "@/app/api/agent/[...path]/handler";
import { GET as authGET, POST as authPOST } from "@/app/api/auth/[[...path]]/handler";
import { GET as githubGET, POST as githubPOST, DELETE as githubDELETE } from "@/app/api/github/[[...path]]/handler";
import { GET as investigationsGET, POST as investigationsPOST, PATCH as investigationsPATCH } from "@/app/api/investigations/[[...path]]/handler";
import { GET as projectsGET, POST as projectsPOST, PATCH as projectsPATCH, DELETE as projectsDELETE } from "@/app/api/projects/[[...path]]/handler";
import { POST as reportsPOST } from "@/app/api/reports/[...path]/handler";
import { GET as targetAuthGET, PATCH as targetAuthPATCH } from "@/app/api/projects/[projectId]/target-auth/handler";
import { GET as runnerGET, POST as runnerPOST } from "@/app/api/runner/[...path]/handler";
import { GET as verificationGET, POST as verificationPOST } from "@/app/api/verification/[...path]/handler";

export const dynamic = "force-dynamic";

type Ctx = { params: { path?: string[] } };

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function relative(path: string[]): string[] {
  return path.slice(1);
}

function isTargetAuth(path: string[]): boolean {
  return path[0] === "projects" && path.length === 3 && path[2] === "target-auth";
}

export async function GET(req: Request, ctx: Ctx) {
  const path = ctx.params.path || [];
  if (path.length === 0) return notFound();
  if (isTargetAuth(path)) return targetAuthGET(req, { params: { projectId: path[1] } });
  const rel = relative(path);
  switch (path[0]) {
    case "agent": return agentGET(req, { params: { path: rel } });
    case "auth": return authGET(req, { params: { path: rel } });
    case "github": return githubGET(req, { params: { path: rel } });
    case "investigations": return investigationsGET(req, { params: { path: rel } });
    case "projects": return projectsGET(req, { params: { path: rel } });
    case "runner": return runnerGET(req, { params: { path: rel } });
    case "verification": return verificationGET(req, { params: { path: rel } });
    default: return notFound();
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const path = ctx.params.path || [];
  if (path.length === 0) return notFound();
  const rel = relative(path);
  switch (path[0]) {
    case "agent": return agentPOST(req, { params: { path: rel } });
    case "auth": return authPOST(req, { params: { path: rel } });
    case "github": return githubPOST(req, { params: { path: rel } });
    case "investigations": return investigationsPOST(req, { params: { path: rel } });
    case "projects": return projectsPOST(req, { params: { path: rel } });
    case "reports": return reportsPOST(req, { params: { path: rel } });
    case "runner": return runnerPOST(req, { params: { path: rel } });
    case "verification": return verificationPOST(req, { params: { path: rel } });
    default: return notFound();
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const path = ctx.params.path || [];
  if (path.length === 0) return notFound();
  if (isTargetAuth(path)) return targetAuthPATCH(req, { params: { projectId: path[1] } });
  const rel = relative(path);
  switch (path[0]) {
    case "investigations": return investigationsPATCH(req, { params: { path: rel } });
    case "projects": return projectsPATCH(req, { params: { path: rel } });
    default: return notFound();
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const path = ctx.params.path || [];
  if (path.length === 0) return notFound();
  const rel = relative(path);
  switch (path[0]) {
    case "github": return githubDELETE(req, { params: { path: rel } });
    case "projects": return projectsDELETE(req, { params: { path: rel } });
    default: return notFound();
  }
}