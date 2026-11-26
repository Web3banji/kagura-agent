import { notFound } from "next/navigation";
import { CommandCenterSection } from "@/components/dashboard/CommandCenterSection";
import ProjectsSection from "@/components/dashboard/ProjectsSection";
import VerificationSection from "@/components/dashboard/VerificationSection";
import ReportsSection from "@/components/dashboard/ReportsSection";
import SettingsSection from "@/components/dashboard/SettingsSection";
import IntegrationsSection from "@/components/dashboard/IntegrationsSection";

export const dynamic = "force-dynamic";

export default async function DashboardSectionPage({
  params,
  searchParams,
}: {
  params: { section: string };
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  switch (params.section) {
    case "command-center":
      return <CommandCenterSection searchParams={searchParams} />;
    case "projects":
      return <ProjectsSection />;
    case "verification":
      return <VerificationSection />;
    case "reports":
      return <ReportsSection searchParams={searchParams} />;
    case "settings":
      return <SettingsSection />;
    case "integrations":
      return <IntegrationsSection />;
    default:
      notFound();
  }
}