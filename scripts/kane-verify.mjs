#!/usr/bin/env node
/**
 * Reusable Kane CLI execution adapter (CLI).
 * - Spawns kane-cli with safe argument array (no shell interpolation of objective)
 * - Forces --agent, tags KANE_CLI_USER_AGENT=kilocode
 * - Captures stdout (NDJSON) and stderr, parses final run_end, maps exit codes
 * - Stores NDJSON artifact and returns actionable JSON to stdout
 *
 * Usage:
 *   node scripts/kane-verify.mjs --url http://localhost:3000 --flow shell-nav [--headless] [--timeout 180] [--name name]
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

const FLOWS = {
  "shell-nav": {
    flow: "shell-nav",
    objective:
      'Go to the provided URL. Verify the page shows "ECHOLOG" and "Command Center". Click the "Agent Journal" link in the sidebar navigation and verify the Agent Journal page is displayed. Click the "Verification Lab" link and verify the Verification Lab page is displayed. Click the "Published Stories" link and verify the Published Stories page is displayed. Return to "Command Center" and verify it is displayed.',
  },
};

function parseArgs(argv) {
  const out = { headless: true, timeout: 180 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--flow") out.flow = argv[++i];
    else if (a === "--objective") out.objective = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--no-headless") out.headless = false;
    else if (a === "--chrome-profile") out.chromeProfile = argv[++i];
  }
  return out;
}

function mapOutcome(exitCode, runEndStatus) {
  if (exitCode === 0 && runEndStatus === "passed") return "passed";
  if (exitCode === 1) return "failed";
  if (exitCode === 2) return "did_not_start";
  if (exitCode === 3) return "timeout";
  if (runEndStatus === "failed") return "failed";
  return "blocked";
}

async function main() {
  const opts = parseArgs(process.argv);
  const flowDef = opts.flow ? FLOWS[opts.flow] : null;
  const objective = opts.objective || flowDef?.objective;
  if (!objective) {
    console.error(JSON.stringify({ outcome: "blocked", error: "Missing --flow or --objective" }));
    process.exit(2);
  }
  if (!opts.url) {
    console.error(JSON.stringify({ outcome: "blocked", error: "Missing --url (real application URL required)" }));
    process.exit(2);
  }

  const outDir = path.join(process.cwd(), "data", "verification", "runs");
  await fs.mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const ndjsonPath = path.join(outDir, `${id}.ndjson`);
  const startedAt = new Date().toISOString();

  let resolvedProfile;
  if (opts.chromeProfile) {
    resolvedProfile = path.isAbsolute(opts.chromeProfile)
      ? opts.chromeProfile
      : path.resolve(process.cwd(), opts.chromeProfile);
    await fs.mkdir(resolvedProfile, { recursive: true });
  }

  const args = ["run", objective, "--agent", "--url", opts.url];
  if (opts.headless) args.push("--headless");
  if (opts.timeout) args.push("--timeout", String(opts.timeout));
  if (opts.name) args.push("--name", opts.name);
  if (resolvedProfile) args.push("--chrome-profile", resolvedProfile);

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
    const result = {
      id, flow: flowDef?.flow || "custom", objective, url: opts.url,
      outcome: "did_not_start", exitCode: 2,
      summary: `Failed to start kane-cli: ${err.message}`,
      startedAt, finishedAt: new Date().toISOString(), ndjsonPath, stderr,
    };
    await fs.writeFile(ndjsonPath, "", "utf8").catch(() => {});
    await appendRecord(result);
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  });

  child.on("close", async (code) => {
    await fs.writeFile(ndjsonPath, stdout, "utf8").catch(() => {});
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    let runEnd;
    let failingStep;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === "run_end") runEnd = evt;
        if (evt.status === "failed" && typeof evt.remark === "string" && !failingStep) failingStep = evt.remark;
      } catch {}
    }
    const outcome = mapOutcome(code, runEnd?.status);
    const evidenceMatch = stderr.match(/(\S+\.evidence\b)/i);
    const durationMs = typeof runEnd?.duration === "number" ? Math.round(runEnd.duration * 1000) : undefined;

    let actionable = undefined;
    if (outcome !== "passed") {
      actionable = {
        diagnosis: code === 2 ? "Run did not start (auth/config/browser/URL/network). Not a test failure." : (failingStep || runEnd?.summary || "Verification failed or blocked."),
        next: code === 2 ? "Check kane-cli auth, browser availability, and target URL reachability." : "Inspect failing step/evidence, fix implementation, rerun the same flow.",
      };
    }

    const result = {
      id,
      flow: flowDef?.flow || "custom",
      objective,
      url: opts.url,
      outcome,
      exitCode: code,
      summary: runEnd?.summary || runEnd?.one_liner,
      failingStep,
      durationMs,
      creditsConsumed: runEnd?.credits_consumed,
      evidencePath: evidenceMatch?.[1],
      testUrl: runEnd?.test_url,
      sessionDir: runEnd?.session_dir,
      startedAt,
      finishedAt: new Date().toISOString(),
      ndjsonPath,
      stderr: stderr || undefined,
      actionable,
    };
    await appendRecord(result);
    console.log(JSON.stringify(result, null, 2));
    process.exit(code ?? 1);
  });
}

async function appendRecord(record) {
  const storeDir = path.join(process.cwd(), "data", "verification");
  const storeFile = path.join(storeDir, "records.json");
  await fs.mkdir(storeDir, { recursive: true });
  let records = [];
  try { records = JSON.parse(await fs.readFile(storeFile, "utf8")); if (!Array.isArray(records)) records = []; } catch {}
  const toStore = { ...record };
  delete toStore.actionable;
  records.unshift(toStore);
  await fs.writeFile(storeFile, JSON.stringify(records, null, 2), "utf8");
}

main();