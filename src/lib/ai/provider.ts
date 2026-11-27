import type { VerificationRecord } from "@/types/verification";
import type { Investigation } from "@/types/investigation";

export interface GenerateArticleInput {
  titleHint: string;
  subtitleHint: string;
  repo?: string;
  observationSource: string;
  observationSummary: string;
  commits: Array<{ sha: string; message: string; date?: string; author?: string; url?: string }>;
  changedFiles: string[];
  analysisReason: string;
  focus: string;
  verification: VerificationRecord | null;
}

export interface GeneratedArticle {
  title: string;
  subtitle: string;
  body: string;
  source: "ai" | "template";
}

function buildPrompt(input: GenerateArticleInput): string {
  const commits = input.commits
    .map((c) => `- ${c.sha.slice(0, 7)} | ${c.date || ""} | ${c.author || ""} | ${c.message}${c.url ? ` | ${c.url}` : ""}`)
    .join("\n") || "- (none)";
  const files = input.changedFiles.slice(0, 40).map((f) => `- ${f}`).join("\n") || "- (none listed)";
  const v = input.verification;
  const ver = v
    ? [
        `Outcome: ${v.outcome} (exit ${v.exitCode ?? "n/a"})`,
        `Flow: ${v.flow}`,
        `URL: ${v.url || "n/a"}`,
        v.summary ? `Summary: ${v.summary}` : null,
        v.failingStep ? `Failing step: ${v.failingStep}` : null,
        typeof v.durationMs === "number" ? `Duration: ${(v.durationMs / 1000).toFixed(1)}s` : null,
        typeof v.creditsConsumed === "number" ? `Credits: ${v.creditsConsumed}` : null,
        v.testUrl ? `Test Manager: ${v.testUrl}` : null,
        v.evidencePath ? `Evidence: ${v.evidencePath}` : null,
      ].filter(Boolean).join("\n")
    : "No Kane verification run attached to this draft.";

  return [
    "You are KAGURA, an autonomous development agent writing a factual development journal entry about your own evolution.",
    "Write a readable, engaging technical development article (credible engineering journal, not marketing copy).",
    "STRICT RULES:",
    "- Use ONLY the provided facts (commits, changed files, observation, analysis, verification).",
    "- NEVER invent features, achievements, fixes, test results, or development activity not supported by the facts.",
    "- If verification failed, was blocked/did_not_start/timeout, or is absent, state that clearly and do not claim verified/completed behaviour.",
    "- A passing verification may be cited as evidence only when outcome is 'passed' with exit 0 (genuine run_end).",
    "- Include relevant commit SHAs/messages and genuine verification outcomes as supporting evidence in the text.",
    "- Output valid JSON with keys: title (string), subtitle (string), body (string, markdown).",
    "",
    `Repository: ${input.repo || "unknown"}`,
    `Observation source: ${input.observationSource}`,
    `Observation summary: ${input.observationSummary}`,
    `Analysis: ${input.analysisReason} (focus: ${input.focus})`,
    "",
    "Commits (actual):",
    commits,
    "",
    "Changed files (actual, may be partial):",
    files,
    "",
    "Verification (actual):",
    ver,
  ].join("\n");
}

function extractJson(text: string): { title?: string; subtitle?: string; body?: string } | null {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function callOpenAI(prompt: string, model: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: "You produce factual, evidence-grounded development journal entries. Return JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(prompt: string, model: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt + "\n\nReturn JSON only." }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
}

function templateArticle(input: GenerateArticleInput): GeneratedArticle {
  const top = input.commits[0];
  const title = input.titleHint || (top ? `Development update: ${top.message}` : "Development update");
  const observationSourceLabel =
    input.observationSource === "github-api"
      ? "GitHub API"
      : input.observationSource === "git-local"
        ? "local git"
        : input.observationSource === "none"
          ? "no verified observation source"
          : input.observationSource;
  const subtitle = input.subtitleHint || `Evidence-grounded report from ${observationSourceLabel} and ${input.verification ? "a real Kane CLI verification run" : "recorded analysis"}.`;
  const commitLines = input.commits.slice(0, 8).map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.message} (${c.date || "n/a"}${c.author ? `, ${c.author}` : ""})`).join("\n") || "- No commits observed.";
  const files = input.changedFiles.slice(0, 20).map((f) => `- ${f}`).join("\n");
  const v = input.verification;
  let verificationSection = "## Verification\nNo Kane verification run was executed for this report.";
  if (v) {
    const verdict = v.outcome === "passed"
      ? "Result: **passed** (genuine Kane `run_end`, exit 0). Behaviour covered by this flow is supported by the recorded evidence."
      : `Result: **${v.outcome}** (exit ${v.exitCode ?? "n/a"}). This is not a verified pass; the report does not claim the checked behaviour as complete.`;
    verificationSection = [
      "## Verification (real Kane CLI evidence)",
      `- Flow: \`${v.flow}\` | Outcome: **${v.outcome}** | Exit: ${v.exitCode ?? "n/a"}`,
      v.url ? `- Target URL: ${v.url}` : null,
      v.summary ? `- Summary: ${v.summary}` : null,
      v.failingStep ? `- Failing step: ${v.failingStep}` : null,
      typeof v.durationMs === "number" ? `- Duration: ${(v.durationMs / 1000).toFixed(1)}s` : null,
      typeof v.creditsConsumed === "number" ? `- Credits consumed: ${v.creditsConsumed}` : null,
      v.testUrl ? `- Test Manager: ${v.testUrl}` : null,
      v.evidencePath ? `- Evidence: ${v.evidencePath}` : null,
      "",
      verdict,
    ].filter(Boolean).join("\n");
  }
  const body = [
    `## What was observed`,
    input.observationSummary,
    "",
    `## Commits (actual)`,
    commitLines,
    files ? `\n## Changed files (observed)\n${files}` : "",
    "",
    `## Analysis`,
    input.analysisReason,
    "",
    verificationSection,
    "",
    `## Evidence boundary`,
    v?.outcome === "passed"
      ? "Claims in this entry are limited to the commits listed above and the passing Kane verification evidence referenced here."
      : "Claims in this entry are limited to observed commits and recorded outcomes. Unverified or failed behaviour is not presented as complete.",
  ].join("\n");
  return { title, subtitle, body, source: "template" };
}

export async function generateArticle(input: GenerateArticleInput): Promise<GeneratedArticle> {
  const provider = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const useProvider = provider === "anthropic" ? "anthropic" : provider === "openai" ? "openai" : provider ? null : hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : null;

  if (!useProvider) return templateArticle(input);

  try {
    const prompt = buildPrompt(input);
    const text = useProvider === "anthropic"
      ? await callAnthropic(prompt, process.env.AI_MODEL || "claude-3-5-sonnet-latest")
      : await callOpenAI(prompt, process.env.AI_MODEL || "gpt-4o-mini");
    const parsed = extractJson(text);
    if (parsed?.title && parsed?.body) {
      return {
        title: String(parsed.title).slice(0, 140),
        subtitle: String(parsed.subtitle || input.subtitleHint || "").slice(0, 240),
        body: String(parsed.body),
        source: "ai",
      };
    }
  } catch {
    // fall through to template on any AI failure - never fabricate, just use factual template
  }
  return templateArticle(input);
}

export interface GeminiReportInput {
  record: VerificationRecord;
  investigations: Investigation[];
  projectName?: string | null;
}

export interface GeminiReportResult {
  provider: "gemini";
  model: string;
  body: string;
}

function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ((process.env.AI_PROVIDER || "").trim().toLowerCase() === "gemini" ? process.env.AI_API_KEY || null : null);
}

export function resolveGeminiConfig(): { configured: boolean; model: string; keySource: "GEMINI_API_KEY" | "GOOGLE_API_KEY" | "AI_API_KEY" | null } {
  const keySource = process.env.GEMINI_API_KEY
    ? "GEMINI_API_KEY"
    : process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : (process.env.AI_PROVIDER || "").trim().toLowerCase() === "gemini" && process.env.AI_API_KEY
        ? "AI_API_KEY"
        : null;
  const model = (process.env.GEMINI_MODEL || process.env.AI_MODEL || "gemini-2.0-flash").trim();
  return { configured: !!keySource && !!model, model, keySource };
}

function buildGeminiPrompt(input: GeminiReportInput): string {
  const r = input.record;
  const issues = input.investigations.length
    ? input.investigations
        .map((inv) =>
          [
            `Title: ${inv.title}`,
            `Severity: ${inv.severity || "not rated"}`,
            `Status: ${inv.status}`,
            `Simple explanation: ${inv.simpleExplanation || "not recorded"}`,
            `Technical explanation: ${inv.technicalExplanation || "not recorded"}`,
            inv.affectedAreas?.length ? `Affected areas: ${inv.affectedAreas.join(", ")}` : null,
            inv.expectedBehaviour ? `Expected: ${inv.expectedBehaviour}` : null,
            inv.actualBehaviour ? `Actual: ${inv.actualBehaviour}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")
    : "No confirmed investigation records are linked to this verification run.";

  return [
    "You are KAGURA's reporting assistant. Write a factual, evidence-grounded verification analysis for a developer.",
    "STRICT RULES:",
    "- Use ONLY the verification record and investigation data provided below.",
    "- Never invent vulnerabilities, findings, file paths, test results, outcomes, or project details.",
    "- If the evidence is insufficient, state that limitation explicitly.",
    "- Do not claim a failed, blocked, did_not_start, or timeout run is a pass.",
    "- Clearly separate original verification facts from your interpretation.",
    "- Return Markdown only. Do not wrap the response in JSON or code fences.",
    "",
    `Project: ${input.projectName || "not recorded"}`,
    `Verification ID: ${r.id}`,
    `Job ID: ${r.jobId || "not recorded"}`,
    `Flow: ${r.flow || "not recorded"}`,
    `Outcome: ${r.outcome}`,
    `Exit code: ${r.exitCode ?? "not recorded"}`,
    `Started: ${r.startedAt}`,
    `Finished: ${r.finishedAt || "not recorded"}`,
    `Summary: ${r.summary || "not recorded"}`,
    `Failing step: ${r.failingStep || "not recorded"}`,
    `Target URL: ${r.url || "not recorded"}`,
    `Evidence path: ${r.evidencePath || "not recorded"}`,
    "",
    "Investigations (actual linked records):",
    issues,
    "",
    "Produce these sections: What was verified; Overall result; Detected issues; Why they matter; Potential impact; Priority; Recommendations; Next steps; Evidence limitations.",
  ].join("\n");
}

export async function generateGeminiVerificationReport(input: GeminiReportInput): Promise<GeminiReportResult> {
  const config = resolveGeminiConfig();
  const key = geminiKey();
  if (!key || !config.configured) {
    throw new Error("Gemini is not configured on the server. Set GEMINI_API_KEY or GOOGLE_API_KEY, or set AI_PROVIDER=gemini with AI_API_KEY.");
  }
  const model = config.model;
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(input) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2200 },
      }),
    });
  } catch {
    throw new Error("Gemini request could not reach the server. Check server network access and Gemini configuration.");
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Gemini authentication failed. Check the server-side Gemini credential configuration.");
    }
    if (res.status === 404) {
      throw new Error(`Gemini model ${model} is unavailable. Configure GEMINI_MODEL or AI_MODEL with a supported model.`);
    }
    throw new Error(`Gemini request failed (${res.status}) for model ${model}. Check server Gemini configuration and model availability.`);
  }
  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    data = await res.json() as typeof data;
  } catch {
    throw new Error("Gemini returned an invalid response.");
  }
  const body = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
  if (!body) throw new Error("Gemini returned no analysis.");
  return { provider: "gemini", model, body };
}

export function aiConfigured(): { configured: boolean; provider: string | null } {
  const provider = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (provider === "gemini") return { configured: !!geminiKey(), provider: "gemini" };
  if (provider === "anthropic") return { configured: !!process.env.ANTHROPIC_API_KEY, provider: "anthropic" };
  if (provider === "openai") return { configured: !!process.env.OPENAI_API_KEY, provider: "openai" };
  if (geminiKey()) return { configured: true, provider: "gemini" };
  if (process.env.ANTHROPIC_API_KEY) return { configured: true, provider: "anthropic" };
  if (process.env.OPENAI_API_KEY) return { configured: true, provider: "openai" };
  return { configured: false, provider: null };
}
