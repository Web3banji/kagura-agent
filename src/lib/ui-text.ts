import type { VerificationOutcome } from "@/types/verification";

export const PIPELINE_STEPS = [
  { id: "OBSERVE", label: "Check for changes", detail: "Looks at your project for new work (like code updates)." },
  { id: "ANALYSE", label: "Understand changes", detail: "Figures out what changed and what matters." },
  { id: "VERIFY", label: "Test it", detail: "Runs real checks to see if things work as expected." },
  { id: "WRITE", label: "Write a draft", detail: "Creates a story draft based on real evidence." },
  { id: "REVIEW", label: "Review", detail: "You read and edit the draft before sharing it." },
  { id: "PUBLISH", label: "Publish", detail: "Makes the approved story visible on the Stories page." },
] as const;

export function stageLabel(stage: string): string {
  return PIPELINE_STEPS.find((s) => s.id === stage)?.label || stage;
}

export function stageDetail(stage: string): string {
  return PIPELINE_STEPS.find((s) => s.id === stage)?.detail || "";
}

export type StatusKind = VerificationOutcome | "idle" | "none" | "completed" | "success" | "skipped";

export function statusInfo(status: string): { label: string; description: string } {
  switch (status) {
    case "idle":
    case "none":
      return { label: "Not started", description: "Nothing has run yet." };
    case "pending":
      return { label: "Waiting", description: "Waiting for its turn to start." };
    case "running":
      return { label: "Working now", description: "This is currently in progress." };
    case "passed":
    case "success":
      return { label: "Looks good", description: "Checks finished successfully with no problems found." };
    case "completed":
      return { label: "Finished", description: "This step completed." };
    case "failed":
      return { label: "Problem found", description: "Something went wrong or a check did not pass." };
    case "blocked":
      return { label: "Couldn't run", description: "The check could not run because of a setup or connection issue (not a pass)." };
    case "did_not_start":
      return { label: "Couldn't start", description: "The check did not start (for example: setup, login, or browser issue). This is not a pass." };
    case "timeout":
      return { label: "Took too long", description: "The check stopped because it ran out of time." };
    case "skipped":
      return { label: "Skipped", description: "This step was not needed this time." };
    default:
      return { label: String(status).replace(/_/g, " "), description: "" };
  }
}
