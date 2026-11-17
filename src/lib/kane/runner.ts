import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { KaneRunResult, VerificationOutcome } from "@/types/verification";

export interface RunKaneOptions {
  objective: string;
  url?: string;
  headless?: boolean;
  timeoutSeconds?: number;
  name?: string;
  chromeProfile?: string;
}

function mapOutcome(exitCode: number | null, runEndStatus?: string): VerificationOutcome {
  if (exitCode === 0 && runEndStatus === "passed") return "passed";
  if (exitCode === 1) return "failed";
  if (exitCode === 2) return "did_not_start";
  if (exitCode === 3) return "timeout";
  if (runEndStatus === "failed") return "failed";
  return "blocked";
}

export async function runKane(options: RunKaneOptions): Promise<KaneRunResult> {
  const outDir = path.join(process.cwd(), "data", "verification", "runs");
  await fs.mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const ndjsonPath = path.join(outDir, `${id}.ndjson`);

  let resolvedProfile: string | undefined;
  if (options.chromeProfile) {
    resolvedProfile = path.isAbsolute(options.chromeProfile)
      ? options.chromeProfile
      : path.resolve(process.cwd(), options.chromeProfile);
    await fs.mkdir(resolvedProfile, { recursive: true });
  }

  const args = ["run", options.objective, "--agent"];
  if (options.url) args.push("--url", options.url);
  if (options.headless ?? true) args.push("--headless");
  if (options.timeoutSeconds) args.push("--timeout", String(options.timeoutSeconds));
  if (options.name) args.push("--name", options.name);
  if (resolvedProfile) args.push("--chrome-profile", resolvedProfile);

  return await new Promise<KaneRunResult>((resolve) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "kane-cli", ...args], {
          env: { ...process.env, KANE_CLI_USER_AGENT: "kilocode" },
          cwd: process.cwd(),
          windowsHide: true,
        })
      : spawn("kane-cli", args, {
          shell: false,
          env: { ...process.env, KANE_CLI_USER_AGENT: "kilocode" },
          cwd: process.cwd(),
        });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", async (err) => {
      await fs.writeFile(ndjsonPath, "", "utf8").catch(() => undefined);
      resolve({
        outcome: "did_not_start",
        exitCode: 2,
        summary: `Failed to start kane-cli: ${err.message}`,
        stderr,
        ndjsonPath,
      });
    });

    child.on("close", async (code) => {
      await fs.writeFile(ndjsonPath, stdout, "utf8").catch(() => undefined);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      let runEnd: Record<string, unknown> | undefined;
      let failingStep: string | undefined;
      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === "run_end") runEnd = evt;
          if (evt.status === "failed" && typeof evt.remark === "string") {
            failingStep = failingStep ?? (evt.remark as string);
          }
        } catch {
          // ignore non-JSON lines
        }
      }

      const status = typeof runEnd?.status === "string" ? (runEnd.status as string) : undefined;
      const outcome = mapOutcome(code, status);
      const durationRaw = runEnd?.duration;
      const durationMs =
        typeof durationRaw === "number"
          ? Math.round(durationRaw * 1000)
          : typeof durationRaw === "string" && !Number.isNaN(Number(durationRaw))
            ? Math.round(Number(durationRaw) * 1000)
            : undefined;

      const evidenceMatch = stderr.match(/(\S+\.evidence\b)/i);
      resolve({
        outcome,
        exitCode: code,
        summary: typeof runEnd?.summary === "string" ? (runEnd.summary as string) : undefined,
        failingStep,
        durationMs,
        creditsConsumed:
          typeof runEnd?.credits_consumed === "number" ? (runEnd.credits_consumed as number) : undefined,
        evidencePath: evidenceMatch?.[1],
        testUrl: typeof runEnd?.test_url === "string" ? (runEnd.test_url as string) : undefined,
        sessionDir: typeof runEnd?.session_dir === "string" ? (runEnd.session_dir as string) : undefined,
        runEnd,
        stderr: stderr || undefined,
        ndjsonPath,
      });
    });
  });
}