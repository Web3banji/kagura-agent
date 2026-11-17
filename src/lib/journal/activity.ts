import { execFile } from "child_process";
import { promisify } from "util";
import type { JournalEvent } from "@/types/journal";
import type { VerificationRecord } from "@/types/verification";

const execFileAsync = promisify(execFile);

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  author: string;
}

export async function getRecentCommits(limit = 10): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-${limit}`, "--pretty=format:%H|%h|%s|%cI|%an"],
      { cwd: process.cwd(), windowsHide: true },
    );
    return stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, message, date, author] = line.split("|");
        return { sha, shortSha, message, date, author };
      });
  } catch {
    return [];
  }
}

export async function getRecentLocalCommits(limit = 5): Promise<JournalEvent[]> {
  const commits = await getRecentCommits(limit);
  return commits.map((c) => ({
    id: `commit-${c.sha}`,
    type: "commit" as const,
    source: "git",
    title: c.message,
    summary: `${c.shortSha} by ${c.author} (real repository history)`,
    timestamp: c.date,
    refs: [c.shortSha],
  }));
}

export function verificationToJournal(record: VerificationRecord): JournalEvent {
  return {
    id: `ver-${record.id}`,
    type: "verification",
    source: "kane-cli",
    title: `${record.flow}: ${record.outcome}`,
    summary: record.summary || "Kane verification executed.",
    timestamp: record.finishedAt || record.startedAt,
    refs: [record.evidencePath, record.testUrl, record.sessionDir, record.ndjsonPath].filter(Boolean) as string[],
  };
}