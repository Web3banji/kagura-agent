export interface JournalEvent {
  id: string;
  type: "commit" | "milestone" | "verification" | "decision" | "observation";
  source: string;
  title: string;
  summary: string;
  timestamp: string;
  refs?: string[];
}