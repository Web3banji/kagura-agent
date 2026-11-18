import { NextResponse } from "next/server";
import { clearSessionCookie, deleteSessionByToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

async function doSignOut() {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE_NAME)?.value;
    if (token) await deleteSessionByToken(token);
  } catch {}
  await clearSessionCookie();
  const base = process.env.KAGURA_APP_URL || process.env.ECHOLOG_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "";
  const to = base ? `${base.replace(/\/+$/, "")}/sign-in?signedout=1` : "/sign-in?signedout=1";
  return NextResponse.redirect(to);
}

export async function POST() {
  return doSignOut();
}

export async function GET() {
  // Convenience; primary sign-out should be POST from UI.
  return doSignOut();
}