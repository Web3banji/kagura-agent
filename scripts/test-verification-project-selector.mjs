import { readFileSync } from "node:fs";

function check(name, condition) {
  if (!condition) {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${name}`);
}

const section = readFileSync("src/components/dashboard/VerificationSection.tsx", "utf8");
const button = readFileSync("src/app/(dashboard)/verification/rerun-button.tsx", "utf8");
const runHandler = readFileSync("src/app/api/verification/[...path]/handler.ts", "utf8");

check("selector uses authorized project ids only", section.includes("resolveProjectIdsForUser") && !section.includes("resolveProjectId("));
check("project metadata is owner-scoped", /WHERE p\.owner_user_id = \$1 AND p\.id = ANY\(\$2::text\[\]\)/.test(section));
check("project metadata excludes target url", section.includes("SELECT p.id, p.name, rc.full_name") && !section.includes("p.target_url"));
check("metadata failure is explicit", section.includes("unavailable: true") && section.includes("projectMetaUnavailable") && button.includes("Project metadata is temporarily unavailable. The project selector cannot be loaded."));
check("project id resolution failure is explicit", section.includes("projectIdsUnavailable = true") && section.includes("projectMetaResult.unavailable || projectIdsUnavailable"));
check("metadata failure is distinct from empty state", section.includes("unavailable: true") && button.includes("metadataUnavailable ?") && button.includes("No projects available. Add or authorize a project before running verification."));
check("selector options come from project metadata", section.includes("const availableProjects = projectMetaUnavailable") && section.includes("availableProjects={availableProjects}"));
check("button values use actual project id", button.includes("value={project.id}"));
check("button labels avoid raw ids and target urls", button.includes("project.repo ? `${project.name} — ${project.repo}` : project.name") && !button.includes("targetUrl") && !button.includes("<option key={id}"));
check("empty selector state is explicit", button.includes("No projects available. Add or authorize a project before running verification."));
check("run request posts selected project id", button.includes("projectId: selectedProjectId") && runHandler.includes("body.projectId"));
check("history remains record-based", section.includes("allRecords.map((r) =>"));