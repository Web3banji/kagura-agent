# KAGURA — AGENTS.md (Project Rules & Mandatory Kane CLI Workflow)

This repository contains **KAGURA**, an autonomous development agent that verifies its work with Kane CLI and publishes factual stories about its own evolution.

## Two agent roles (keep distinct)
- **Kilo Code — Development Agent:** builds and maintains KAGURA. Must use Kane CLI as part of normal implementation and correction workflow (not only final testing).
- **KAGURA — Autonomous Product Agent:** observes real project history, identifies meaningful changes, invokes Kane CLI to verify relevant behaviour, interprets results, and decides what it can truthfully report. Must never invent commits, test results, successful flows, or development achievements.

## Project principles
- Build a genuine agent workflow: `OBSERVE → ANALYSE → VERIFY → WRITE → REVIEW → PUBLISH`. Do not simulate autonomy.
- **Never fabricate** repository activity, verification results, articles, or published content. A failed verification is not a pass; failed/unverified features must not be claimed as complete/verified.
- Work in small, verifiable milestones. Inspect before changing. Test features before marking complete.
- Never hardcode API keys or credentials. Never commit secrets, `.env*` (except `.env.example`), tokens, or private Kane evidence (`.testmuai/evidence/`, evidence packs).
- Keep integrations honest: local Kane execution requires an available, authenticated runner with a supported browser; do not assume deployed environments can run local Kane CLI.

## Mandatory everyday development cycle (Kane + checks)
For every meaningful task that changes application behaviour:
1. Define task and acceptance criteria.
2. Implement the change.
3. Identify relevant user journeys and browser checks.
4. Invoke Kane CLI against the **actual running application** URL.
5. Capture and parse the actual Kane execution result (NDJSON `run_end`, exit code).
6. Feed the result back into decisions. If verification fails, inspect failure, fix implementation, and rerun.
7. Record the final outcome. Only mark **verified** when a genuine successful Kane result supports it.
8. If verification cannot run: label **UNVERIFIED** or **BLOCKED** (never PASSED). Do not waste credits on unrelated full suites for trivial changes.

Kane CLI is used **alongside** (not instead of) TypeScript checks (`npm run typecheck`), linting (`npm run lint`), and appropriate unit tests.

## Kane CLI execution (required usage)
- Use Kane CLI for real browser/UI verification. **Do not substitute Playwright, Puppeteer, or Selenium for Kane browser verification.**
- Always pass `--agent` to `kane-cli run` and `kane-cli testmd run`.
- Tag commands with `KANE_CLI_USER_AGENT=kilocode` (set per command; in PowerShell: `$env:KANE_CLI_USER_AGENT='kilocode'; ...`).
- Always provide a real application URL (`--url`). Use `--headless` when appropriate.
- Parse NDJSON output and read final `run_end` (or `test_md_done` / `testrun_done`). Exit codes: `0` pass, `1` failed, `2` did not start, `3` timeout/cancelled.
- On failure: inspect evidence, diagnose, fix, rerun. **Never claim successful verification without a genuine passing result.**
- Save meaningful reusable browser flows as Kane test files when appropriate. **Never commit secrets or evidence packs** (`.testmuai/evidence/`, local `data/` verification artifacts are gitignored).

**Reusable runner (project):** `node scripts/kane-verify.mjs --url <real-url> --flow shell-nav [--headless] [--timeout 180]`
- Captures NDJSON to `data/verification/runs/`, appends structured records to `data/verification/records.json` (gitignored), returns actionable JSON (outcome, exit code, summary, failing step, evidence refs).

**Environment/readiness:** before first run of a session check `kane-cli whoami`, `kane-cli balance`, `kane-cli config show`. Use a Kane-compatible browser (Google Chrome installed) with a dedicated writable profile; in this workspace `chrome_profile` is configured to the absolute gitignored path `data/verification/kane-chrome-profile` and Chrome compatibility has been **proven** by a genuine Kane `run_end` pass (shell-nav, exit 0, run `b0f88bc3-f486-4082-a3e8-d0543d134752`). Do not reuse personal/in-use browser profiles.

## Kilo task hook / automation
- Inspected `.kilo/` (project) and global Kilo config: **no reliable Kilo task-hook/automation mechanism was found or configured** for automatic Kane invocation. Do not assume a hook exists.
- **Mandatory workflow instead:** follow the everyday cycle above and use the reusable script/adapter (`scripts/kane-verify.mjs`) and Checks & tests records for each meaningful UI/behaviour change.

## Engineering practices
- Use safe process argument handling for Kane execution (argument arrays, no shell interpolation of objectives/URLs); capture structured output and preserve genuine results.
- Keep architecture modular: agent logic, AI generation, verification, and publishing separated with clear error handling and recovery.
- Persist real observations, execution records, verification results, and editorial state (PostgreSQL planned) — no fake data.
- Maintain clear documentation and a working end-to-end product over unnecessary features.
