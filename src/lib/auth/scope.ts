import type { AuthPrincipal } from "./index";
import { principalHasLegacyAccess } from "./guards";
import { AccessDeniedError, isAccessDeniedError } from "./errors";

export { AccessDeniedError, isAccessDeniedError };

export interface RecordScope {
  userId?: string;
  includeLegacy?: boolean;
  privileged?: boolean;
}

export function scopeForPrincipal(
  principal: Pick<AuthPrincipal, "kind" | "user" | "userId">,
  opts?: { legacyAccess?: boolean },
): RecordScope {
  const legacyAccess = opts?.legacyAccess ?? principalHasLegacyAccess(principal);
  // Platform-wide administrative access: separate admin-token infrastructure auth, local-dev,
  // and the bootstrap owner (the original single-owner operator of the existing workspace).
  if (principal.kind === "admin-token" || principal.kind === "dev") {
    return { privileged: true, includeLegacy: true };
  }
  if (principal.kind === "user") {
    if (principal.user?.isBootstrapOwner) {
      // Bootstrap owner retains platform-wide administrative access over the workspace
      // it originally owned, including records created by newer accounts.
      return { userId: principal.userId, includeLegacy: true, privileged: true };
    }
    // Ordinary authenticated users: strictly their own records, never legacy/global data.
    return {
      userId: principal.userId,
      includeLegacy: legacyAccess,
      privileged: false,
    };
  }
  return { includeLegacy: legacyAccess, privileged: false };
}

export function canAccessOwnedRecord(ownerId: string | null | undefined, scope: RecordScope): boolean {
  if (scope.privileged) return true;
  if (ownerId == null) return !!scope.includeLegacy;
  if (!scope.userId) return false;
  return ownerId === scope.userId;
}

export function filterVisible<T extends { userId?: string | null }>(items: T[], scope: RecordScope): T[] {
  if (scope.privileged) return items;
  return items.filter((item) => {
    if (item.userId == null) return !!scope.includeLegacy;
    if (!scope.userId) return false;
    return item.userId === scope.userId;
  });
}

/**
 * Ownership test for records identified by `requestedBy` (verification jobs and
 * verification records) rather than `userId` (stories and agent runs).
 *
 * Fails closed: when a principal is constrained to its own identity, records with
 * no recorded owner (legacy/platform records) are only visible when `includeLegacy`
 * is explicitly granted.
 */
export function canAccessRequestedByRecord(
  ownerId: string | null | undefined,
  scope: Pick<RecordScope, "userId" | "includeLegacy" | "privileged">,
): boolean {
  if (scope.privileged) return true;
  if (ownerId == null || ownerId === "") return !!scope.includeLegacy;
  if (!scope.userId) return false;
  return ownerId === scope.userId;
}

/**
 * Translate a RecordScope into the query options accepted by the verification
 * stores. `requestedBy` is intentionally omitted for privileged scopes so that
 * platform administrators retain the existing global view.
 */
export function scopeToRecordQuery(scope: RecordScope): { requestedBy?: string; includeLegacy: boolean } {
  if (scope.privileged) return { includeLegacy: true };
  return { requestedBy: scope.userId, includeLegacy: !!scope.includeLegacy };
}

/**
 * Force the owner of a newly created record to the acting principal unless the
 * scope is privileged (admin-token / local-dev / bootstrap owner), which may
 * create legacy or platform-owned records.
 */
export function ownedUserIdForCreate(scope: RecordScope, requested?: string | null): string | null | undefined {
  if (scope.privileged) return requested ?? undefined;
  return scope.userId ?? null;
}

/**
 * True when a non-privileged principal may not change the owner field of a record.
 */
export function canChangeOwner(scope: RecordScope): boolean {
  return !!scope.privileged;
}