import { promises as fs } from "fs";
import path from "path";
import type { Story } from "@/types/story";
import { hasDatabase, isProductionRuntime, kvGet, kvMutate } from "@/lib/db";
import type { RecordScope } from "@/lib/auth/scope";
import { canAccessOwnedRecord, filterVisible } from "@/lib/auth/scope";
import { AccessDeniedError } from "@/lib/auth/scope";

const DATA_DIR = path.join(process.cwd(), "data", "stories");
const FILE = path.join(DATA_DIR, "stories.json");
const STORIES_KEY = "stories:all";

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

async function readLegacyStoriesFile(): Promise<Story[] | undefined> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Story[]) : [];
  } catch {
    return undefined;
  }
}

async function seedStoriesIfNeeded(): Promise<void> {
  const existing = await kvGet<Story[]>(STORIES_KEY);
  if (Array.isArray(existing)) return;
  const legacy = await readLegacyStoriesFile();
  if (Array.isArray(legacy) && legacy.length > 0) {
    await kvMutate<Story[]>(STORIES_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
  }
}

export async function readStories(scope?: RecordScope): Promise<Story[]> {
  if (hasDatabase()) {
    const existing = await kvGet<Story[]>(STORIES_KEY);
    const all = Array.isArray(existing) ? existing : await (async () => {
      const legacy = await readLegacyStoriesFile();
      if (Array.isArray(legacy)) {
        if (legacy.length > 0) {
          try {
            await kvMutate<Story[]>(STORIES_KEY, (cur) => (Array.isArray(cur) && cur.length > 0 ? cur : legacy));
          } catch {}
        }
        return legacy;
      }
      return [];
    })();
    return scope ? filterVisible(all, scope) : all;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable story storage is not configured (DATABASE_URL missing in production).");
  }
  await ensureLocal();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Story[];
    const all = Array.isArray(parsed) ? parsed : [];
    return scope ? filterVisible(all, scope) : all;
  } catch {
    return [];
  }
}

export async function writeStories(stories: Story[]): Promise<void> {
  if (hasDatabase()) {
    await seedStoriesIfNeeded();
    await kvMutate<Story[]>(STORIES_KEY, () => stories);
    return;
  }
  if (!canUseLocalFs()) {
    throw new Error("Durable story storage is not configured (DATABASE_URL missing in production).");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(stories, null, 2), "utf8");
}

export async function getStoryById(id: string, scope?: RecordScope): Promise<Story | undefined> {
  return (await readStories(scope)).find((s) => s.id === id);
}

export async function getStoryBySlug(slug: string, opts?: { publishedOnly?: boolean }): Promise<Story | undefined> {
  const story = (await readStories()).find((s) => s.slug === slug);
  if (!story) return undefined;
  if (opts?.publishedOnly && story.status !== "published") return undefined;
  return story;
}

/**
 * Insert or update a story.
 *
 * Authorization is derived from the *stored* owner, never from the incoming payload:
 *  - Updating a story owned by another principal is rejected.
 *  - A non-privileged principal cannot change the owner field.
 *  - Creating a story as a non-privileged principal forces the owner to that principal,
 *    so a forged `userId` cannot create or claim a record on someone else's behalf.
 */
export async function upsertStory(story: Story, scope?: RecordScope): Promise<Story> {
  const applyCreate = (incoming: Story): Story => {
    if (!scope || scope.privileged) return incoming;
    return { ...incoming, userId: scope.userId ?? null };
  };

  if (hasDatabase()) {
    await seedStoriesIfNeeded();
    await kvMutate<Story[]>(STORIES_KEY, (current) => {
      const stories = Array.isArray(current) ? [...current] : [];
      const idx = stories.findIndex((s) => s.id === story.id);
      if (idx >= 0) {
        const existing = stories[idx];
        if (scope && !canAccessOwnedRecord(existing.userId, scope)) {
          throw new AccessDeniedError("Access denied");
        }
        if (scope && !scope.privileged && (story.userId ?? null) !== (existing.userId ?? null)) {
          throw new AccessDeniedError("Cannot change the owner of an existing story");
        }
        stories[idx] = { ...story, userId: existing.userId };
      } else {
        stories.unshift(applyCreate(story));
      }
      return stories;
    });
    return story;
  }
  const stories = await readStories();
  const idx = stories.findIndex((s) => s.id === story.id);
  if (idx >= 0) {
    const existing = stories[idx];
    if (scope && !canAccessOwnedRecord(existing.userId, scope)) {
      throw new AccessDeniedError("Access denied");
    }
    if (scope && !scope.privileged && (story.userId ?? null) !== (existing.userId ?? null)) {
      throw new AccessDeniedError("Cannot change the owner of an existing story");
    }
    stories[idx] = { ...story, userId: existing.userId };
  } else {
    stories.unshift(applyCreate(story));
  }
  await writeStories(stories);
  return story;
}