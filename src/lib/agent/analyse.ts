import type { Observation } from "./observe";

export interface Analysis {
  deservesVerification: boolean;
  reason: string;
  focus: "shell-nav" | "command-center" | "stories" | "general";
  objective: string;
  flow: string;
}

const SHELL_FLOW = "shell-nav";
const SHELL_OBJECTIVE = 'Go to the provided URL. Verify the page shows "KAGURA" and "Home & status". Click the "Activity history" link in the sidebar navigation and verify the Activity history page is displayed. Click the "Checks & tests" link in the sidebar navigation and verify the Checks & tests page is displayed. Click the "Published stories" link in the sidebar navigation and verify the Stories page is displayed. Return to "Home & status" and verify it is displayed.';

export function analyse(observation: Observation): Analysis {
  const files = observation.changedFiles.join(" ").toLowerCase();
  const msgs = observation.commits.map((c) => c.message).join(" ").toLowerCase();
  const text = files + " " + msgs;

  let focus: Analysis["focus"] = "general";
  if (text.includes("stories") || text.includes("publish") || text.includes("editorial")) focus = "stories";
  else if (text.includes("command") || text.includes("dashboard")) focus = "command-center";
  else if (text.includes("layout") || text.includes("sidebar") || text.includes("page") || text.includes("src/app")) focus = "shell-nav";

  const deservesVerification =
    observation.commits.length > 0 &&
    (text.includes("src/") ||
      text.includes("app") ||
      text.includes("page") ||
      text.includes("component") ||
      text.includes("layout") ||
      focus !== "general" ||
      observation.changedFiles.length === 0);

  return {
    deservesVerification,
    reason: deservesVerification
      ? `Meaningful application/repository changes observed (focus: ${focus}). Verification required before reporting.`
      : "No application-behavior changes detected that warrant a Kane browser run.",
    focus,
    flow: SHELL_FLOW,
    objective: SHELL_OBJECTIVE,
  };
}