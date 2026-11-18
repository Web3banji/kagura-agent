import { spawn } from "child_process";
import { promises as fs, statSync as statSyncFn } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  buildChildEnv,
  isShellSafeArg,
  normalizeTimeout,
  validateFlow,
  validateObjective,
  validateUrl,
} from "@/lib/kane/security";
import type { KaneRunResult, VerificationOutcome } from "@/types/verification";

export interface RunKaneOptions {
  objective: string;
  url?: string;
  headless?: boolean;
  timeoutSeconds?: number;
  name?: string;
  chromeProfile?: string;
}


/**
 * Locate the kane-cli Node entry point so the runner never has to go through
 * cmd.exe. Resolution order: explicit override, npm global root, node install
 * root. Returns an absolute path to kane-cli.cjs or undefined.
 */
function resolveKaneCliEntry(cwd: string): string | undefined {
  const override = process.env.KAGURA_KANE_CLI_JS;
  const rel = path.join("node_modules", "@testmuai", "kane-cli", "bin", "kane-cli.cjs");
  const candidates: string[] = [];
  if (override) candidates.push(path.resolve(cwd, override));
  candidates.push(path.join(cwd, rel));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", rel));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "nodejs", rel));
  candidates.push(path.join(path.dirname(process.execPath), rel));
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      if (statSyncFn(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // keep looking
    }
  }
  return undefined;
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
  const cwd = process.cwd();
  const outDir = path.join(cwd, "data", "verification", "runs");
  await fs.mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const ndjsonPath = path.join(outDir, `${id}.ndjson`);

  const objectiveResult = validateObjective(options.objective);
  const urlResult = options.url ? validateUrl(options.url) : null;

  const rejection = !objectiveResult.ok
    ? objectiveResult.reason
    : urlResult && !urlResult.ok
      ? urlResult.reason
      : null;

  if (rejection) {
    const summary = `Refusing to execute: ${rejection}`;
    await fs.writeFile(ndjsonPath, "", "utf8").catch(() => undefined);
    return {
      id,
      flow: options.name,
      objective: options.objective,
      url: options.url,
      outcome: "did_not_start",
      exitCode: 2,
      summary,
      ndjsonPath,
      command: "kane-cli (rejected before spawn)",
    };
  }

  let resolvedProfile: string | undefined;
  const profileInput =
    options.chromeProfile ||
    process.env.KANE_BROWSER_PROFILE ||
    path.join(cwd, "data", "verification", "kane-chrome-profile");
  if (profileInput) {
    const resolved = path.isAbsolute(profileInput)
      ? profileInput
      : path.resolve(cwd, profileInput);
    const profilesRoot = path.join(cwd, "data", "verification", "profiles");
    const defaultProfile = path.join(cwd, "data", "verification", "kane-chrome-profile");
    if (resolved !== defaultProfile && !resolved.startsWith(profilesRoot + path.sep)) {
      await fs.writeFile(ndjsonPath, "", "utf8").catch(() => undefined);
      return {
        id,
        flow: options.name,
        objective: options.objective,
        url: options.url,
        outcome: "did_not_start",
        exitCode: 2,
        summary: "Refusing to execute: chrome profile resolves outside the allowed profile roots.",
        ndjsonPath,
        command: "kane-cli (rejected before spawn)",
      };
    }
    resolvedProfile = resolved;
    await fs.mkdir(resolvedProfile, { recursive: true });
  }

  const flowResult = validateFlow(options.name);
  const flow = flowResult.ok ? flowResult.flow : "shell-nav";
  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const headless = options.headless !== false;
  const name = `kagura-${flow}`;

  const objectiveValue =
    objectiveResult.ok && typeof objectiveResult.objective === "string"
      ? objectiveResult.objective
      : "";
  const args: string[] = ["run", objectiveValue, "--agent"];
  if (urlResult?.ok && urlResult.url) args.push("--url", urlResult.url);
  if (headless) args.push("--headless");
  args.push("--timeout", String(timeoutSeconds));
  args.push("--name", name);
  if (resolvedProfile) args.push("--chrome-profile", resolvedProfile);

  const userAgent = process.env.KANE_CLI_USER_AGENT?.trim() || "kilocode";

  const spawnInfo: { target: string; argv: string[] } | undefined = (() => {
    if (process.platform === "win32") {
      const entry = resolveKaneCliEntry(cwd);
      if (!entry) return undefined;
      return { target: process.execPath, argv: [entry, ...args] };
    }
    const bin = process.env.KAGURA_KANE_CLI_BIN?.trim() || "kane-cli";
    if (!isShellSafeArg(bin)) return undefined;
    return { target: bin, argv: args };
  })();

  const command = `KANE_CLI_USER_AGENT=${userAgent} kane-cli ${args.join(" ")}`;

  if (!spawnInfo) {
    await fs.writeFile(ndjsonPath, "", "utf8").catch(() => undefined);
    return {
      id,
      flow: name,
      objective: options.objective,
      url: options.url,
      outcome: "did_not_start",
      exitCode: 2,
      summary:
        "Runner misconfigured: could not locate the kane-cli Node entry point. " +
        "Set KAGURA_KANE_CLI_JS to the absolute path of kane-cli.cjs (the npm .cmd shim is never used).",
      ndjsonPath,
      command,
    };
  }

  const childEnv = buildChildEnv(process.env, {
    overrides: { KANE_CLI_USER_AGENT: userAgent },
  }) as NodeJS.ProcessEnv;

  const child = spawn(spawnInfo.target, spawnInfo.argv, {
    env: childEnv,
    cwd,
    shell: false,
    windowsVerbatimArguments: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<KaneRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", async (err) => {
      await fs.writeFile(ndjsonPath, "", "utf8").catch(() => undefined);
      resolve({
        id,
        flow: name,
        objective: options.objective,
        url: options.url,
        outcome: "did_not_start",
        exitCode: 2,
        summary: `Failed to start kane-cli: ${err.message}`,
        stderr,
        ndjsonPath,
        command,
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
        id,
        flow: name,
        objective: options.objective,
        url: options.url,
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
        command,
      });
    });
  });
}
