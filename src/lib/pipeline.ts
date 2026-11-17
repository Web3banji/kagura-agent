export const PIPELINE_STAGES = [
  "OBSERVE",
  "ANALYSE",
  "VERIFY",
  "WRITE",
  "REVIEW",
  "PUBLISH",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function getCurrentPipelineState() {
  return {
    agentState: "idle" as const,
    stage: "OBSERVE" as PipelineStage,
    note: "Foundation initialized. No autonomous pipeline run has been executed yet.",
  };
}