# ECHOLOG — AGENTS.md (Project Rules & Mandatory Kane CLI Workflow)

This repository contains **ECHOLOG**, an autonomous development agent that verifies its work with Kane CLI and publishes factual stories about its own evolution.

## Project principles
- Build a genuine agent workflow: `OBSERVE → ANALYSE → VERIFY → WRITE → REVIEW → PUBLISH`. Do not simulate autonomy.
- **Never fabricate** repository activity, verification results, articles, or published content. A failed verification is not a pass; failed/unverified features must not be claimed as complete/verified.
- Work in small, verifiable milestones. Inspect before changing. Test features before marking complete.
- Never hardcode API keys or credentials. Never commit secrets, `.env*` (except `.env.example`), tokens, or private Kane evidence (`.testmuai/evidence/`, evidence packs).
- Keep integrations honest: local Kane execution requires an available, authenticated runner with a supported browser; do not assume deployed environments can run local Kane CLI.

## Mandatory Kane CLI development workflow
Kane CLI (`@testmuai/kane-cli`) is required for real browser/UI verification in this project.

**Environment & readiness**
- Install/auth as needed: `npm install -g @testmuai/kane-cli`, `kane-cli login`/`kane-cli login --oauth` (user-completed when interactive browser/device flow required).
- Before first run of a session, check: `kane-cli whoami`, `kane-cli balance`, `kane-cli config show`.
- Local browser runs require a supported browser (Chrome or a configured compatible browser profile/executable as supported by Kane config). Do not claim verification works until an actual Kane flow passes.

**Required usage rules**
- Use Kane CLI for real browser interactions and UI verification. **Do not substitute Playwright, Puppeteer, or Selenium for Kane browser verification.**
- Always pass `--agent` to `kane-cli run` and `kane-cli testmd run`.
- Tag commands with `KANE_CLI_USER_AGENT=kilocode` (set per command as appropriate for the shell/host).
- Always provide a real application URL (`--url` or URL in objective). Use `--headless` when appropriate (CI/SSH/no display).
- Parse NDJSON output and read the final `run_end` event (or `test_md_done` / `testrun_done` for suite/testmd runs). Treat exit codes correctly: `0` pass, `1` failed, `2` did not start, `3` timeout/cancelled.
- On failure: inspect evidence, diagnose the problem, fix it, and rerun. **Never claim successful verification without a genuine passing result.**
- Save meaningful reusable browser flows as Kane test files when appropriate (e.g. `_test.md` with recordings/output as supported). Commit test sources/recordings only when intended; **never commit secrets or evidence packs** (`.testmuai/evidence/`).
- After each significant UI implementation, perform a relevant Kane CLI verification. Do not defer Kane integration to the end.

**Reporting results**
- Report pass/fail in plain language with summary, failing step (if any), duration/credits when available, and evidence/Test Manager references when present. Exit `2` means “did not start” (not a test failure).

## Engineering practices
- Use safe process argument handling for Kane execution; capture structured output and preserve genuine results.
- Keep architecture modular: agent logic, AI generation, verification, and publishing separated with clear error handling and recovery.
- Persist real observations, execution records, verification results, and editorial state (PostgreSQL planned) — no fake data.
- Maintain clear documentation and a working end-to-end product over unnecessary features.
