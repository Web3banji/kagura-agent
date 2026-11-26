import { spawn } from "node:child_process";

export class RepositoryCheckoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryCheckoutError";
  }
}

export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function minimalGitEnv(token) {
  const env = {
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || process.env.windir || "",
    windir: process.env.windir || process.env.SystemRoot || "",
    TEMP: process.env.TEMP || process.env.TMP || "",
    TMP: process.env.TMP || process.env.TEMP || "",
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    ...gitAuthEnv(token),
  };
  return env;
}

function runGit(args, opts, spawnFn, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch {}
      finish({ code: null, stdout, stderr: stderr || `Timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);
    try {
      child = spawnFn("git", args, {
        cwd: opts.cwd,
        env: minimalGitEnv(opts.token),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, stdout, stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on?.("error", (err) => finish({ code: null, stdout, stderr: stderr || (err instanceof Error ? err.message : String(err)), timedOut: false }));
    child.on?.("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut: false }));
  });
}

function sanitize(message, token) {
  return token ? String(message).split(token).join("[redacted]") : String(message);
}

export async function cloneRepository({ repoFullName, branch, token, checkoutDir, spawnFn = spawn, timeoutMs = 120000 }) {
  if (!repoFullName || !branch || !token) throw new RepositoryCheckoutError("Repository clone requires repository identity, branch, and credential");
  const [owner, name] = String(repoFullName).split("/");
  if (!owner || !name || name.includes("..")) throw new RepositoryCheckoutError("Invalid repository identity");
  const url = `https://github.com/${owner}/${name}.git`;
  const res = await runGit(["clone", "--single-branch", "--branch", branch, "--depth", "1", url, checkoutDir], { token }, spawnFn, timeoutMs);
  if (res.timedOut || res.code !== 0) {
    throw new RepositoryCheckoutError(`Repository clone failed: ${sanitize(res.stderr || "unknown git error", token)}`);
  }
  const remote = await runGit(["-C", checkoutDir, "remote", "get-url", "origin"], { token }, spawnFn, timeoutMs);
  if (remote.code !== 0 || !String(remote.stdout).includes(`${owner}/${name}`)) {
    throw new RepositoryCheckoutError("Repository checkout remote identity verification failed");
  }
  const current = await runGit(["-C", checkoutDir, "rev-parse", "--abbrev-ref", "HEAD"], { token }, spawnFn, timeoutMs);
  if (current.code !== 0 || String(current.stdout).trim() !== branch) {
    throw new RepositoryCheckoutError(`Repository checkout branch verification failed: expected ${branch}`);
  }
  return { checkoutDir, branch, remote: String(remote.stdout).trim() };
}