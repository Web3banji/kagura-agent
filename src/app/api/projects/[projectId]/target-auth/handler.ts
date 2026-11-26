import { NextResponse } from "next/server";
import { requireUserApi, apiErrorResponse } from "@/lib/auth/guards";
import { getPool, ensureDb, hasDatabase } from "@/lib/db";
import { validateProjectTargetAuthConfig } from "@/lib/target-auth/validate";
import type { ProjectTargetAuthConfig } from "@/types/target-auth";

export const dynamic = "force-dynamic";

function mapConfig(row: Record<string, unknown>): ProjectTargetAuthConfig {
  const mode = row.target_auth_mode;
  const evidence = row.target_auth_evidence;
  return {
    targetAuthMode:
      mode === "public" || mode === "protected" || mode === "unconfigured"
        ? mode
        : "unconfigured",
    ...(evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? { targetAuthEvidence: evidence as ProjectTargetAuthConfig["targetAuthEvidence"] }
      : {}),
  };
}

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  const projectId = (params.projectId || "").trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const res = await getPool().query(
      `SELECT target_auth_mode, target_auth_evidence FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [projectId, user.id],
    );
    if (res.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ projectId, config: mapConfig(res.rows[0]) });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { projectId: string } }) {
  const userOrRes = await requireUserApi(req);
  if (!(userOrRes as { id?: string }).id) return userOrRes as Response;
  const user = userOrRes as { id: string };
  const projectId = (params.projectId || "").trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  if (!hasDatabase()) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 500 });
  }
  try {
    await ensureDb();
    const ownerRes = await getPool().query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [projectId, user.id],
    );
    if (ownerRes.rowCount === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as unknown;
    const validation = validateProjectTargetAuthConfig(body);
    if (!validation.ok || !validation.value) {
      return NextResponse.json({ error: "Invalid target auth configuration", details: validation.errors }, { status: 400 });
    }
    const cfg = validation.value;
    await getPool().query(
      `UPDATE projects SET target_auth_mode = $1, target_auth_evidence = $2, updated_at = NOW() WHERE id = $3 AND owner_user_id = $4`,
      [cfg.targetAuthMode, cfg.targetAuthEvidence ? JSON.stringify(cfg.targetAuthEvidence) : null, projectId, user.id],
    );
    return NextResponse.json({ projectId, config: cfg });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
