import type { Investigation, CreateInvestigationInput, UpdateInvestigationInput } from "@/types/investigation";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate } from "@/lib/db";
import type { RecordScope } from "@/lib/auth/scope";
import { canAccessOwnedRecord } from "@/lib/auth/scope";

const DATA_DIR = path.join(process.cwd(), "data", "investigations");
const FILE = path.join(DATA_DIR, "investigations.json");
const INVESTIGATIONS_KEY = "investigations:all";

import { promises as fs } from "fs";
import path from "path";

function canUseLocalFs(): boolean {
  return !hasDatabase() && !isProductionRuntime();
}

async function ensureLocal() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, "[]", "utf8");
  }
}

async function readLegacyInvestigationsFile(): Promise<Investigation[] | undefined> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Investigation[]) : [];
  } catch {
    return undefined;
  }
}

async function seedInvestigationsIfNeeded(): Promise<void> {
  const existing = await kvGet<Investigation[]>(INVESTIGATIONS_KEY);
  if (Array.isArray(existing)) return;
  const legacy = await readLegacyInvestigationsFile();
  if (Array.isArray(legacy) && legacy.length > 0) {
    await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
  }
}

export async function readInvestigations(scope?: RecordScope): Promise<Investigation[]> {
  if (hasDatabase()) {
    const existing = await kvGet<Investigation[]>(INVESTIGATIONS_KEY);
    const all = Array.isArray(existing) ? existing : await (async () => {
      const legacy = await readLegacyInvestigationsFile();
      if (Array.isArray(legacy)) {
        if (legacy.length > 0) {
          try {
            await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
          } catch {}
        }
        return legacy;
      }
      return [];
    })();
    return scope ? filterVisibleByOwner(all, scope) : all;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable investigation storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureLocal();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Investigation[];
    const all = Array.isArray(parsed) ? parsed : [];
    return scope ? filterVisibleByOwner(all, scope) : all;
  } catch {
    return [];
  }
}

function filterVisibleByOwner(items: Investigation[], scope: RecordScope): Investigation[] {
  if (scope.privileged) return items;
  return items.filter((item) => {
    if (item.ownerUserId == null) return !!scope.includeLegacy;
    if (!scope.userId) return false;
    return item.ownerUserId === scope.userId;
  });
}

export async function writeInvestigations(investigations: Investigation[]): Promise<void> {
  if (hasDatabase()) {
    await seedInvestigationsIfNeeded();
    await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, () => investigations);
    return;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable investigation storage is not configured (DATABASE_URL missing in production).");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(investigations, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

export async function getInvestigationById(id: string, scope?: RecordScope): Promise<Investigation | undefined> {
  return (await readInvestigations(scope)).find((i) => i.id === id);
}

export async function createInvestigation(input: CreateInvestigationInput): Promise<Investigation> {
  const now = new Date().toISOString();
  const investigation: Investigation = {
    id: crypto.randomUUID(),
    ownerUserId: input.ownerUserId,
    projectId: input.projectId ?? null,
    repositoryConnectionId: input.repositoryConnectionId ?? null,
    title: input.title,
    category: input.category ?? null,
    technicalExplanation: input.technicalExplanation,
    simpleExplanation: input.simpleExplanation,
    rootCause: input.rootCause ?? null,
    affectedAreas: input.affectedAreas ?? null,
    expectedBehaviour: input.expectedBehaviour ?? null,
    actualBehaviour: input.actualBehaviour ?? null,
    severity: input.severity ?? null,
    status: input.status ?? "open",
    firstDetectedAt: now,
    lastDetectedAt: now,
    verificationReferences: input.verificationReferences ?? [],
    evidenceReferences: input.evidenceReferences ?? null,
    aiFixPrompt: input.aiFixPrompt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  if (hasDatabase()) {
    await seedInvestigationsIfNeeded();
    await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, (current) => {
      const investigations = Array.isArray(current) ? [...current] : [];
      investigations.unshift(investigation);
      return investigations;
    });
    return investigation;
  }

  const investigations = await readInvestigations();
  investigations.unshift(investigation);
  await writeInvestigations(investigations);
  return investigation;
}

export async function updateInvestigation(id: string, patch: UpdateInvestigationInput, scope?: RecordScope): Promise<Investigation | undefined> {
  const apply = (investigations: Investigation[]): { next: Investigation[]; updated?: Investigation } => {
    const idx = investigations.findIndex((i) => i.id === id);
    if (idx < 0) return { next: investigations };
    if (scope && !canAccessOwnedRecord(investigations[idx].ownerUserId, scope)) {
      return { next: investigations };
    }
    const updated: Investigation = {
      ...investigations[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    // Non-privileged principals cannot change the owner.
    if (!scope || !scope.privileged) {
      updated.ownerUserId = investigations[idx].ownerUserId;
    }
    const next = [...investigations];
    next[idx] = updated;
    return { next, updated };
  };

  if (hasDatabase()) {
    await seedInvestigationsIfNeeded();
    let updated: Investigation | undefined;
    await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, (current) => {
      const base = Array.isArray(current) ? current : [];
      const res = apply(base);
      updated = res.updated;
      return res.next;
    });
    return updated;
  }

  const investigations = await readInvestigations();
  const res = apply(investigations);
  if (!res.updated) return undefined;
  await writeInvestigations(res.next);
  return res.updated;
}

export async function appendVerificationReference(
  id: string,
  reference: { verificationId: string; jobId?: string; outcome: string; detectedAt: string; evidencePath?: string; failingStep?: string; summary?: string },
  scope?: RecordScope,
): Promise<Investigation | undefined> {
  const apply = (investigations: Investigation[]): { next: Investigation[]; updated?: Investigation } => {
    const idx = investigations.findIndex((i) => i.id === id);
    if (idx < 0) return { next: investigations };
    if (scope && !canAccessOwnedRecord(investigations[idx].ownerUserId, scope)) {
      return { next: investigations };
    }
    const existing = investigations[idx];
    // Avoid duplicating the same verification reference.
    const alreadyExists = existing.verificationReferences.some((r) => r.verificationId === reference.verificationId);
    const references = alreadyExists
      ? existing.verificationReferences.map((r) => (r.verificationId === reference.verificationId ? { ...r, ...reference, detectedAt: reference.detectedAt } : r))
      : [...existing.verificationReferences, reference];
    const updated: Investigation = {
      ...existing,
      verificationReferences: references,
      lastDetectedAt: reference.detectedAt,
      updatedAt: new Date().toISOString(),
    };
    if (!scope || !scope.privileged) {
      updated.ownerUserId = existing.ownerUserId;
    }
    const next = [...investigations];
    next[idx] = updated;
    return { next, updated };
  };

  if (hasDatabase()) {
    await seedInvestigationsIfNeeded();
    let updated: Investigation | undefined;
    await kvMutate<Investigation[]>(INVESTIGATIONS_KEY, (current) => {
      const base = Array.isArray(current) ? current : [];
      const res = apply(base);
      updated = res.updated;
      return res.next;
    });
    return updated;
  }

  const investigations = await readInvestigations();
  const res = apply(investigations);
  if (!res.updated) return undefined;
  await writeInvestigations(res.next);
  return res.updated;
}

