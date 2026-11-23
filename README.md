# KAGURA

KAGURA — an autonomous development agent that verifies its work with Kane CLI and publishes factual stories about its own evolution.

> **Status:** repository and environment preparation in progress. Integrations (GitHub observation, PostgreSQL, AI provider, Kane-authenticated browser verification) are not yet configured and no application features are claimed complete.

## What this project is
KAGURA is intended to implement a genuine agent workflow:

`OBSERVE → ANALYSE → VERIFY → WRITE → REVIEW → PUBLISH`

- **Observe:** retrieve actual repository/development activity.
- **Analyse:** identify meaningful changes worth documenting.
- **Verify:** execute relevant UI/feature checks through Kane CLI and read real results.
- **Write:** generate drafts grounded in commits and verification evidence (distinguishing verified facts from unverified claims).
- **Review:** owner reviews/edits/approves drafts.
- **Publish:** approved articles appear on a public blog.

## Current workspace state
- Next.js (App Router, TypeScript, Tailwind) scaffold present at repository root.
- `AGENTS.md` defines mandatory Kane CLI development workflow for this repo.
- `.env`/secrets and Kane evidence are gitignored; use `.env.example` as a template (no real credentials committed).

## Local development (scaffold)
```bash
npm install
npm run dev
```
(Requires Node.js/npm. Database, GitHub, AI provider, and Kane verification must be configured before end-to-end agent features can work.)

## Verification
UI and browser verification for this project must use **Kane CLI** (not Playwright/Puppeteer/Selenium as a substitute for Kane verification). See `AGENTS.md` for required flags, evidence handling, and failure workflow.

- `npm run kane:verify -- --url <real-url> --flow shell-nav [--headless]` — reusable local Kane CLI adapter (writes NDJSON/records under `data/verification/`).
- `npm run kane:runner` — persistent Windows/local runner that connects to the deployed KAGURA coordinator, claims queued jobs, executes Kane CLI locally, and syncs genuine results back (never runs Kane on Vercel).

## Windows runner (Stage 2)

### Prerequisites
1. **Node.js** and **npm** installed (project requires Node 20+; this repo has been used with Node 24 on Windows).
2. **Kane CLI** installed and authenticated on this machine:
   - Install/upgrade per Kane docs, then verify:
     ```powershell
     kane-cli --version
     kane-cli whoami
     ```
3. **Google Chrome** installed (supported browser) and a dedicated writable Chrome profile available (proven profile path in this workspace): `data\verification\kane-chrome-profile`.
4. Network access from this machine to the deployed KAGURA app URL you will test (if Vercel Deployment Protection is enabled, the runner must be able to reach the target; use an accessible URL/bypass/custom domain as configured).

### Configure environment (local, gitignored)
1. Copy the template and fill in real values (never commit secrets, never put the runner token in frontend/public vars):
   ```powershell
   Copy-Item .env.runner.example .env.runner
   notepad .env.runner
   ```
2. Set at minimum:
   - `KAGURA_APP_URL` = deployed KAGURA coordinator base URL (e.g. `https://<your-deployment>.vercel.app` or production domain)
   - `KAGURA_RUNNER_TOKEN` = must match the server-side `KAGURA_RUNNER_TOKEN` configured in Vercel (runner auth is separate from dashboard user auth)
   - `KANE_CLI_USER_AGENT=kilocode`
3. Optional: `KAGURA_RUNNER_ID` (stable id; auto-generated/persisted to `data/verification/runner-id` if unset), `KAGURA_RUNNER_VERSION`, polling/heartbeat tuning.

### Start the runner (PowerShell)
```powershell
Set-Location 'C:\Users\HP\AppData\Roaming\Kilo Desktop\chats\session-eMHkrI'
npm run kane:runner
```
On successful startup/connect/auth you should see logs such as: `KAGURA RUNNER STARTED`, `Backend connected`, `Runner authenticated`, `Heartbeat successful`, then periodic `Checking for jobs...`.

### Stop safely
- Press `Ctrl+C` in the runner terminal (SIGINT). The runner stops claiming new jobs and, if a job is executing, finishes the current execution and attempts to sync its result before exiting.
- Do not force-kill during result sync unless necessary; unsynced results are retained locally under `data\verification\pending-sync\` for recovery on next start.

### How it behaves
- One active job at a time. Claims via `/api/runner/claim`, heartbeats via `/api/runner/heartbeat`, completes via `/api/runner/complete` (Bearer `KAGURA_RUNNER_TOKEN`). HTTP 204 = no jobs available.
- Executes genuine `kane-cli run --agent ...` locally with headless Chrome and the dedicated profile; parses NDJSON `run_end` and syncs real outcomes/evidence refs. No simulated results.
- Retries transient network/sync failures with backoff and retains failed sync payloads locally (never discarded).

### Server-side (Vercel) requirements
- `DATABASE_URL` configured (durable jobs/records/heartbeat) and `KAGURA_RUNNER_TOKEN` set to the same secret used by the runner.
- Vercel remains coordinator only (never executes Kane CLI).


## License
TBD

## Investigation storage limitations
- Investigation storage uses KV/local filesystem. KV uses transactional row locking; local filesystem writes are atomic via temp+rename but cross-process concurrency is not globally locked.
- Distributed atomic locking is not supported by this architecture.
