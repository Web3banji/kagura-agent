import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { getCurrentUser } from "@/lib/auth/session";
import { getServerPrincipal } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Any authenticated principal (user session or admin-token infrastructure access) may
  // use the dashboard. Data isolation is enforced per-request by the pages/APIs through
  // RecordScope, not by this layout.
  const principal = await getServerPrincipal();
  if (!principal.authorized) {
    redirect("/sign-in");
  }

  if (principal.kind === "admin-token") {
    return <AppShell currentUser={null} adminTokenAccess>{children}</AppShell>;
  }

  const user = await getCurrentUser();
  return <AppShell currentUser={user}>{children}</AppShell>;
}