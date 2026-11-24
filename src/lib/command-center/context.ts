export type CommandCenterProjectContext = {
  selectedProjectId: "all" | string;
  visibleProjectIds: string[];
  allowLegacy: boolean;
};

export function resolveSelectedProjectId(requestedProject: string | undefined, visibleProjectIds: string[]): "all" | string {
  const requested = (requestedProject || "").trim();
  if (!requested || requested === "all") return "all";
  return visibleProjectIds.includes(requested) ? requested : "all";
}

export function scopeIdsForContext(ctx: CommandCenterProjectContext): string[] {
  return ctx.selectedProjectId === "all" ? ctx.visibleProjectIds : [ctx.selectedProjectId];
}

export function recordVisibleInContext(
  record: { projectId?: string | null },
  ctx: CommandCenterProjectContext,
): boolean {
  const scoped = scopeIdsForContext(ctx);
  if (record.projectId) return scoped.includes(record.projectId);
  return ctx.selectedProjectId === "all" ? ctx.allowLegacy : false;
}
