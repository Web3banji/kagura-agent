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

## License
TBD
