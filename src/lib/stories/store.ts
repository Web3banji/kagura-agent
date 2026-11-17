import { promises as fs } from "fs";
import path from "path";
import type { Story } from "@/types/story";

const DATA_DIR = path.join(process.cwd(), "data", "stories");
const FILE = path.join(DATA_DIR, "stories.json");

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, "[]", "utf8");
  }
}

export async function readStories(): Promise<Story[]> {
  await ensure();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Story[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeStories(stories: Story[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(stories, null, 2), "utf8");
}

export async function getStoryById(id: string): Promise<Story | undefined> {
  return (await readStories()).find((s) => s.id === id);
}

export async function getStoryBySlug(slug: string): Promise<Story | undefined> {
  return (await readStories()).find((s) => s.slug === slug);
}

export async function upsertStory(story: Story): Promise<Story> {
  const stories = await readStories();
  const idx = stories.findIndex((s) => s.id === story.id);
  if (idx >= 0) stories[idx] = story;
  else stories.unshift(story);
  await writeStories(stories);
  return story;
}