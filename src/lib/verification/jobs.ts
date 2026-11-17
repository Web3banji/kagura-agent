import { promises as fs } from "fs";
import path from "path";
import type { VerificationJob } from "@/types/verification";

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(JOBS_FILE); } catch { await fs.writeFile(JOBS_FILE, "[]", "utf8"); }
}

export async function readJobs(): Promise<VerificationJob[]> {
  await ensure();
  try {
    const raw = await fs.readFile(JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as VerificationJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function writeJobs(jobs: VerificationJob[]): Promise<void> {
  await ensure();
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs.slice(0, 100), null, 2), "utf8");
}

export async function enqueueJob(job: Omit<VerificationJob, "id" | "status" | "createdAt"> & { id?: string }): Promise<VerificationJob> {
  const jobs = await readJobs();
  const record: VerificationJob = {
    id: job.id || crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    ...job,
  };
  jobs.unshift(record);
  await writeJobs(jobs);
  return record;
}

export async function claimNextJob(runnerId?: string): Promise<VerificationJob | null> {
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.status === "pending");
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], status: "claimed", claimedAt: new Date().toISOString(), claimedBy: runnerId };
  await writeJobs(jobs);
  return jobs[idx];
}

export async function getJob(id: string): Promise<VerificationJob | undefined> {
  return (await readJobs()).find((j) => j.id === id);
}

export async function updateJob(id: string, patch: Partial<VerificationJob>): Promise<VerificationJob | undefined> {
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return undefined;
  jobs[idx] = { ...jobs[idx], ...patch };
  await writeJobs(jobs);
  return jobs[idx];
}
