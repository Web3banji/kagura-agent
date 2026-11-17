import { promises as fs } from "fs";
import path from "path";
import type { JournalEvent } from "@/types/journal";
import type { VerificationRecord } from "@/types/verification";

export async function getRecentLocalCommits(limit = 5): Promise<JournalEvent[]> {
  try {
    const head = await fs.readFile(path.join(process.cwd(), ".git", "logs", "HEAD"), "utf8");
    const lines = head.trim().split(/\r?\n/).reverse().slice(0, limit);
    return lines.map((line, i) => {
      const parts = line.split("\t");
      const msg = parts[1] || "commit";
      const tsMatch = line.match(/\s(\d{10})\s[+-]\d{4}\t/);
      const ts = tsMatch ? new Date(Number(tsMatch[1]) * 1000).toISOString() : new Date().toISOString();
      return {
        id: `local-${i}-${ts}`,
        type: "commit" as const,
        source: "local-git",
        title: msg.trim(),
        summary: "Observed from local git reflog (real repository history).",
        timestamp: ts,
      };
    });
  } catch {
    return [];
  }
}

export function verificationToJournal(record: VerificationRecord): JournalEvent {
  return {
    id: `ver-${record.id}`,
    type: "verification",
    source: "kane-cli",
    title: `${record.flow}: ${record.outcome}`,
    summary: record.summary || "Kane verification executed.",
    timestamp: record.finishedAt || record.startedAt,
    refs: [record.evidencePath, record.testUrl, record.sessionDir].filter(Boolean) as string[],
  };
}