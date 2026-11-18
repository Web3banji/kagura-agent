import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  // Never expose secrets/tokens; return minimal identity only.
  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      githubLogin: user.githubLogin,
      isBootstrapOwner: user.isBootstrapOwner,
    },
  });
}