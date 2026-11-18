# KAGURA — UI/UX, User Flow & Functionality Audit Report

**Status:** Audit & design specification only. No code changes, no database changes, no authentication changes, no runner changes, no commits/pushes/deploys.

**Source of truth:** Live inspection of `C:\Users\HP\AppData\Roaming\Kilo Desktop\chats\session-eMHkrI` (Next.js 14.2.35, pg, Neon DB, Tailwind, Geist fonts). Every page and component listed below was read directly from the repository.

---

## 1. Existing application audit

### Routes and pages

| Route | Type | Exists | Notes |
|---|---|---|---|
| `/` | page | Yes | Redirects to `/command-center` (no public landing) |
| `/sign-in` | page | Yes | GitHub OAuth sign-in; public stories link |
| `/command-center` | dashboard page | Yes | Home & status; start check, check for changes |
| `/journal` | dashboard page | Yes | Activity history (commits + checks + tests) |
| `/verification` | dashboard page | Yes | Checks & tests; real results |
| `/editorial` | dashboard page | Yes | Review drafts; save/regenerate/reject/publish |
| `/stories` | public page | Yes | Published stories list |
| `/stories/[slug]` | public page | Yes | Individual story detail |
| `/settings` | dashboard page | Yes | GitHub, AI, runner, publishing & safety |

There is **no** `/projects`, `/teams`, `/integrations`, or `/reports` page. Those sections exist conceptually (GitHub integration lives inside `/settings`) but have no dedicated route.

### API routes

All real, backed by DB/KV stores:

- `POST/GET /api/agent/run` — run the observe→analyse→verify→write pipeline (creates draft)
- `GET /api/agent/status` — pipeline state + runs + observation
- `POST /api/agent/approve` — publish a draft
- `POST /api/editorial/publish|update|reject|regenerate` — story mutations
- `POST/GET /api/verification/jobs` — queue & list verification jobs (owner-scoped)
- `POST /api/verification/run` — queue a one-off shell-nav verification
- `POST /api/github/observe` — check GitHub for changes (now owner-only after hardening)
- `POST/GET /api/github/config` — set GitHub repo (now owner-only after hardening)
- `POST /api/runner/claim|heartbeat|complete` — runner protocol (runner-token auth)
- `POST/GET /api/auth/signin/github`, `/api/auth/callback/github`, `/api/auth/session`, `/api/auth/signout` — GitHub OAuth + sessions

### Navigation & layout

- `Sidebar`: 6 links (Home & status, Activity history, Checks & tests, Review drafts, Published stories, Settings). Active-state highlighting. Brand → `/command-center`.
- `AppShell`: two-column layout (sidebar collapsed on mobile), max-w-[1200px] content, mobile header with sign-out form.
- `(dashboard)/layout.tsx`: auth gate — redirects unauthenticated to `/sign-in`; allows user sessions and admin-token infrastructure access.

### Authentication & GitHub OAuth

Real, database-backed flow:
- `GET /api/auth/signin/github` → creates one-time `oauth_states` row (10-min TTL) → redirects to GitHub
- `GET /api/auth/callback/github` → exchanges code → fetches profile → upserts user + encrypted tokens → creates session cookie (`__Secure-kagura.session` prod / `kagura.session` dev)
- `GET /api/auth/session` — minimal identity, no secrets
- `POST /api/auth/signout` — deletes session + clears cookie
- Scope model: user / admin-token / dev / anonymous → `RecordScope` (userId, includeLegacy, privileged). Bootstrap owner = privileged.

### Multi-user functionality

Implemented and **verified** (permanent tests added in prior session, 18/18 passing against real Neon DB):
- Stories, agent runs, verification jobs and records are owner-scoped; ordinary users cannot read or mutate each other's records.
- Bootstrap owner sees all; admin-token is privileged.
- Legacy (ownerless) records visible only when `includeLegacy` granted.
- `/api/github/config` and `/api/github/observe` POST are owner-only.
- Unauthenticated / invalid session → 401.

### Neon database & persistence

Tables: `users`, `accounts`, `sessions`, `projects`, `oauth_states`, `echolog_kv` (KV), `verification_jobs` (claim/lease). `kvMutate` atomic RMW with `FOR UPDATE`. Local JSON fallback only when `!hasDatabase() && !isProductionRuntime()`; production without DB throws. `projects` table exists with `owner_user_id` but there is **no projects UI**.

### GitHub integration

- `readGitHubConfig` / `writeGitHubConfig` (env > DB > local file > default)
- `observeGitHub` — fetches commits from GitHub API (or local git fallback), merges, persists `ObservationState` + `ObservedCommit[]`
- `GITHUB_TOKEN`/`GH_TOKEN` for reads; `GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME` for repo binding
- Configuration form in `/settings` (disabled when bound via env)

### Kane CLI & runner

- `scripts/kane-verify.mjs` — one-shot verify adapter (genuine `run_end` NDJSON parsing, exit codes)
- `scripts/kane-runner.mjs` — persistent daemon: claim → heartbeat → execute → complete, with pending-sync queue
- `scripts/runner-security.mjs` — input validation + stripped child env
- `scripts/runner-isolation.mjs` + `scripts/setup-runner-isolation.ps1` — OS-level isolation gate (fail-closed; not live-verified, see hardening report)
- Kane runs **only** on the local Windows runner, never on Vercel
- `runKane` in `src/lib/kane/runner.ts` — validated, shell-free, `node.exe` invocation

### Activity Journal

Real. `/journal` merges stored `JournalEvent[]`, verification events (`verificationToJournal`), and observed GitHub events into a newest-first timeline. Commit files with +/- counts. Empty states present.

### Verification

Real. `/verification` shows passed/problems/blocked counts and a test history with technical details (URL, exit code, evidence, session dir, run log, stderr). Results come from real Kane runs synced via the runner. Empty state present.

### Editorial & reporting

Real. `/editorial` lists drafts (review/draft), rejected, and published. `DraftActions` client component: Save changes, Write a new draft (regenerate), Discard (reject), Approve & publish — each calls the real API with busy/msg/err states. Publication is explicit (no auto-publish).

### Settings

Real. GitHub connection (token/badge, config form, observe action), AI writing (OpenAI/Anthropic or template fallback), testing runner (heartbeat, pending jobs, last success), publishing & safety policy.

### Reusable UI components

Only 4 component files: `AppShell`, `Sidebar` (layout), `StatusBadge`, `Primitives` (`PageHeader`, `Panel`, `EmptyState`, `WorkflowStrip`). `DraftActions`, `RunPipelineButton`, `ObserveButton`, `RerunVerificationButton`, `GitHubConfigForm`, `ObserveAction` are page-co-located (not shared). No dedicated buttons/inputs/forms/cards/tables/dialogs/dropdowns component library exists.

### Responsive behaviour

Sidebar collapses on mobile (`md:hidden`), mobile header replaces it. Grids use `md:`/`lg:`/`xl:` column variants. Generally responsive but uses a custom design token system (`--bg`, `--fg`, `--accent`, etc.) rather than Tailwind's semantic palette.

### Existing errors / incomplete / non-functional elements

1. **No public landing page.** `/` redirects straight into the authed dashboard; public value prop is only on `/stories`.
2. **No Projects page** though a `projects` table exists. Project creation, repository selection, and project switching have no UI.
3. **No Teams page** — workspace owner inviting team members has no UI.
4. **No Integrations page** — GitHub config is crammed into `/settings` alongside AI and runner.
5. **No Reports page** — verification results live under `/verification`; there is no report creation/export UI.
6. **Observe button shown to all users**, but `/api/github/observe` POST is now owner-only → non-owner clicks get a 403 error (UX mismatch).
7. **GitHub config form shown to all users**, but POST is owner-only → same UX mismatch.
8. **No empty/loading/error component library** — each page co-locates its own empty states and error handling.
9. **StatusBadge accepts a broad union** including arbitrary strings (`"idle" | "none" | "completed" | "success" | "skipped"`) — type imprecision.
10. **Dark theme is the current look** (`--bg #040303`), while the product direction specifies light-mode primary with burnt-orange #E96B38 — a deliberate visual rebase is needed, but out of scope for this audit phase.

---

## 2. Current functionality matrix

| Feature | Purpose | Actual functionality | Data | API deps | User actions | Permissions | Empty state | Loading state | Error state | Responsive |
|---|---|---|---|---|---|---|---|---|---|---|
| Home (`/`) | Entry | Redirects to dashboard | — | — | Redirect | Any | — | — | — | — |
| Sign-in (`/sign-in`) | Auth | GitHub OAuth; error codes; DB/OAuth config checks | sessions, users, accounts, oauth_states | `/api/auth/*` | Continue with GitHub | Unauthenticated | n/a | n/a | Inline error + config messages | Yes (centered card) |
| Command center | Overview | Pipeline state, runs, verification summary, observed events, latest run stages | runs, stories, verification, jobs, observation | agent/status, github/observe | Start check, check for changes | Authorized | Welcome panel / empties | n/a (server-rendered) | lastError text | Yes (grid) |
| Journal | Activity | Timeline of commits + checks + tests | journal events, verification records, observed events | journal/store, github/store | View details | Authorized | "No activity yet" | n/a | lastError text | Yes |
| Verification | Test results | Passed/problems/blocked counts + per-result details | verification records | verification/store | Run a test now (rerun button) | Authorized | "No tests have been run yet" | busy on rerun button | inline err | Yes |
| Editorial | Drafts | Save, regenerate, reject, publish drafts | stories | editorial/{update,reject,publish,regenerate} | Edit title/subtitle/body, actions | Authorized (owner-scoped) | "No drafts to review" | busy per button | inline err/msg | Yes |
| Stories | Published output | Public list + detail; verification outcome badge | stories | readStories (public) | Read story | Public (published only) | "No stories published yet" | n/a | — | Yes |
| Stories/[slug] | Story detail | Full body, commits, files, test result | stories | getStoryBySlug | Read | Public (published only) | notFound if draft | n/a | — | Yes |
| Settings | Configuration | GitHub config form, AI status, runner heartbeat, safety policy | github config, heartbeat, jobs | github/config, jobs, ai/provider | Save project, check for changes | Authorized (config save owner-only) | n/a | busy on save/check | inline err/msg | Yes (grid) |
| Run pipeline | Check | Runs observe→analyse→verify→write pipeline | runs, stories, verification | agent/run | Start a new check | Authorized | busy "Working..." | busy | inline msg | Yes |
| Observe | Check changes | Queries GitHub/local git for commits | observed events | github/observe | Check for changes | Authorized (owner-only POST) | busy "Checking..." | busy | inline err/msg | Yes |
| Rerun verification | Test | Queues shell-nav job for runner | verification jobs/records | verification/run | Run a test now | Authorized | busy "Queueing..." | busy | inline err | Yes |
| DraftActions | Draft editor | Edit + save/regenerate/reject/publish | stories | editorial/* | Edit fields, actions | Authorized (owner-scoped) | n/a | busy per button | inline err/msg | Yes |

**Controls that call real APIs:** all of the above buttons/actions invoke real routes with busy/error states. None are purely decorative.

**Controls with permission mismatch:** `ObserveButton` (command center), `ObserveAction` (settings), `GitHubConfigForm` (settings) are rendered to all authorized users but their POST endpoints are owner-only after hardening — non-owners receive a 403 on submission.

---

## 3. Proposed information architecture

Map product sections to routes. Existing routes are reused; new sections are noted as gaps.

| Product section | Existing route | Status | Notes |
|---|---|---|---|
| Overview | `/command-center` | Exists | Reuse as-is |
| Projects | — | Missing | No UI; `projects` table exists |
| Activity | `/journal` | Exists | Reuse |
| Intelligence | `/editorial` + `/stories` | Exists | Draft review + public stories |
| Verification | `/verification` | Exists | Reuse |
| Reports | — | Missing | No report creation/export |
| Integrations | `/settings` (GitHub only) | Partial | GitHub crammed into settings |
| Team | — | Missing | No invite/team UI |
| Settings | `/settings` | Exists | Reuse; could split GitHub out to Integrations |

Suggested route additions (design only, not implemented): `/projects`, `/projects/[id]`, `/integrations`, `/team`, `/reports`, `/reports/[id]`, `/` (public landing).

---

## 4. Complete user journeys

Each journey lists screens, actions, validation, loading states, error states, and successful outcomes. Backend routes referenced are real.

### 4.1 New individual user
1. **Screen:** `/` → redirect `/sign-in` (requires DB + GitHub OAuth configured; else config message).
2. **Action:** Click "Continue with GitHub".
3. **Validation:** `githubOAuthConfigured()` and `hasDatabase()` checked server-side.
4. **Loading:** Browser redirect to GitHub; no app-level spinner (OAuth flow).
5. **Error:** `invalid_state`, `access_denied`, `missing_params` → user-facing message on `/sign-in`; never raw stack traces.
6. **Outcome:** GitHub profile upserted, session cookie set, redirect to `/command-center`.

### 4.2 Returning individual user
1. **Screen:** `/sign-in` → `getCurrentUser()` → redirect `/command-center`.
2. **Screen:** `/command-center` — server-rendered pipeline state, runs, verification summary, observed events.
3. **Outcome:** Sees own records only (owner-scoped).

### 4.3 User connecting GitHub
1. **Screen:** `/settings` → "Project updates (GitHub)" panel.
2. **Validation:** `GITHUB_TOKEN`/`GH_TOKEN` env for reads; `GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME` for binding. Config form disabled when bound via env.
3. **Action:** Save project (owner-only POST `/api/github/config`) or "Check for changes now" (`/api/github/observe`).
4. **Loading:** busy "Checking for changes...".
5. **Error:** inline `text-rose-300` message; 403 if non-owner (UX mismatch — see §9).
6. **Outcome:** commits merged into `ObservedCommit[]`, `ObservationState` updated.

### 4.4 User creating a project manually
**Missing functionality.** No UI exists. The `projects` table (`owner_user_id`, name, slug, is_bootstrap) is present but there is no create-project screen, no project switcher, and no project-scoped navigation.

### 4.5 User selecting an existing repository
Part of the missing Projects flow. Currently repo selection is via env/DB `github:config` (single platform repo) — no per-user or per-project repo picker in the UI.

### 4.6 User requesting Kane verification
1. **Screen:** `/verification` → "Run a test now" (`RerunVerificationButton`).
2. **Action:** POST `/api/verification/run` → job enqueued with `requestedBy = current user`.
3. **Loading:** busy "Queueing a verification job...".
4. **Execution:** Runner claims job, executes Kane under OS isolation (fail-closed), syncs result via `/api/runner/complete` (owner derived from job record, not payload).
5. **Error:** inline "The test could not be queued." / runner sync retry queue (never silently discards).
6. **Outcome:** Verification record appears in `/verification` history with real outcome + evidence.

### 4.7 User reviewing project intelligence
1. **Screen:** `/command-center` → "Stories" panel → "Review drafts now" → `/editorial`.
2. **Screen:** `/editorial` → `DraftActions`: edit title/subtitle/body; view observed commits + test result for transparency.
3. **Action:** Save (`/api/editorial/update`), regenerate (`/api/editorial/regenerate`), reject (`/api/editorial/reject`), or approve & publish (`/api/editorial/publish`).
4. **Validation:** story ownership enforced; published stories cannot be edited; owner cannot reassign owner.
5. **Loading:** busy per button with label (e.g. "Publishing...").
6. **Error:** inline `text-rose-300` "Something went wrong: {message}".
7. **Outcome:** published story appears on `/stories` and `/stories/[slug]`.

### 4.8 User creating a report
**Missing functionality.** No Reports page and no report creation/export UI exists. Verification results are viewable but not reportable.

### 4.9 Workspace owner inviting team members
**Missing functionality.** No Teams page and no invite/membership UI. Multi-user isolation exists at the data layer but there is no UI to add users to a project/workspace.

### 4.10 Team member accessing an authorized project
**Missing functionality.** No project-scoped access UI; no workspace switcher.

---

## 5. Design system specification

### Design tokens (proposed, per product direction)

| Token | Proposed value | Current | Note |
|---|---|---|---|
| Primary orange | #E96B38 | --accent #e04000 | Product direction burnt-orange |
| Soft background | #F5F6F8 | --bg #040303 | Shift dark → light primary |
| Charcoal | #20232B | --fg #f6f1eb | Invert for light mode |
| Success green | #239B59 | --success #34d399 | Adjust |
| Warning amber | #D99018 | --warning #f59e0b | Adjust |
| Error red | #D94848 | --danger #ff4d4d | Adjust |
| Info blue | #3478C7 | — | New |
| AI accent purple | #7957C8 | — | New |

### Components to build
Sidebar, top navigation, workspace switcher, project switcher, buttons, inputs, forms, cards, tables, status indicators, notification banners, dialogs, dropdowns, empty states, loading skeletons, error states, success states, AI insight panels.

### Consistency rules
- Single source of tokens (CSS variables / Tailwind config) replacing the current scattered `--bg/--fg/--accent` custom tokens.
- Light mode primary; dark mode supported via `dark:` variant.
- Controlled colour: accent used for primary actions and status only; no excessive gradients/animations/oversized cards.
- Responsive breakpoints: mobile-first, `sm`/`md`/`lg`/`xl`.
- Typography: keep Geist Sans + Geist Mono.

---

## 6. Page-by-page UI/UX specification

| Page | Purpose | Empty state | Loading | Error | Permissions | Responsive | Gaps |
|---|---|---|---|---|---|---|---|
| `/sign-in` | Auth | n/a | n/a | inline config/error | Unauthenticated | Yes | None significant |
| `/command-center` | Overview | Welcome panel | n/a | lastError text | Authorized | Yes | Observe button shown to non-owners (403 on click) |
| `/journal` | Activity | "No activity yet" | n/a | lastError text | Authorized | Yes | None |
| `/verification` | Tests | "No tests have been run yet" | busy on rerun | inline err | Authorized | Yes | None |
| `/editorial` | Draft review | "No drafts to review" | busy per button | inline err/msg | Authorized | None | None |
| `/stories` | Published output | "No stories published yet" | n/a | — | Public | Yes | None |
| `/stories/[slug]` | Story detail | notFound if draft | n/a | — | Public | Yes | None |
| `/settings` | Config | n/a | busy on save/check | inline err/msg | Authorized | Yes | GitHub config form shown to non-owners (403 on save) |
| `/` | Entry | n/a | n/a | — | — | — | Redirects to authed dashboard; no public landing |

---

## 7. Backend and API dependencies

All listed routes are real and implemented. Dependencies per section:
- Overview: `agent/status`, `github/observe` (status), `verification/store`, `stories/store`, `agent/runs`
- Activity: `journal/store`, `verification/store`, `github/store`, `github/observe`
- Verification: `verification/store`, `verification/jobs`, `verification/run`
- Editorial: `stories/store`, `agent/runs`, `editorial/*`
- Stories: `stories/store` (public read)
- Settings: `github/config`, `github/observe`, `verification/jobs` (heartbeat, jobs), `ai/provider`
- Projects/Integrations/Team/Reports: **no routes/pages exist** — would need new API routes and DB usage (projects table already exists).

---

## 8. Missing functionality

1. **Projects section** — no create/select/switch project UI (DB table exists).
2. **Teams section** — no invite/member UI.
3. **Integrations section** — GitHub config buried in `/settings`; no dedicated page.
4. **Reports section** — no report creation/export.
5. **Public landing page** — `/` redirects to authed dashboard.
6. **Shared component library** — no buttons/inputs/forms/cards/tables/dialogs/dropdowns components.
7. **Design tokens** — custom dark-theme tokens; product direction wants light mode + burnt-orange.

---

## 9. Identified UX problems

1. **Permission/render mismatch:** `ObserveButton`, `ObserveAction`, and `GitHubConfigForm` are shown to every authorized user, but their backing POST routes (`/api/github/observe`, `/api/github/config`) are owner-only after the security hardening. Non-owners click and receive a 403 error instead of the action working. Fix: gate visibility on `scope.privileged` or owner status.
2. **No distinction between 401/403/404 for cross-user actions** in some flows (publish/regenerate another user's story returns 404 by design to avoid enumerating, which is acceptable but should be consistent).
3. **Error messages co-located and inconsistent** — no unified error component; each page inlines its own `text-rose-300` text.
4. **No loading skeletons** — buttons show busy text but page content has no skeleton states.
5. **Dark theme vs. product direction** — current look is dark (`#040303` bg); direction calls for light-mode primary with burnt-orange #E96B38.

---

## 10. Recommended implementation sequence

1. **Fix permission/render mismatch** (§9.1): gate `ObserveButton`/`ObserveAction`/`GitHubConfigForm` on `scope.privileged` so non-owners never see owner-only actions.
2. **Add shared component library + design tokens** (§5): buttons, inputs, forms, cards, tables, dialogs, dropdowns, empty states, skeletons, error/success banners; migrate pages incrementally.
3. **Public landing page** (`/`): marketing/value-prop instead of redirecting to dashboard.
4. **Projects section** (`/projects`, `/projects/[id]`, project switcher): use existing `projects` table; owner-scoped.
5. **Integrations section** (`/integrations`): move GitHub config out of `/settings`.
6. **Team section** (`/team`): invite/members UI on top of existing multi-user data isolation.
7. **Reports section** (`/reports`): report creation/export from verification records.
8. **Visual rebase** (last): light-mode primary, burnt-orange #E96B38, per product direction — do after structure is stable so rework is minimized.

---

**Note on verification status:** This report is an audit and design specification. No implementation was performed in this phase. All "exists" claims were verified by reading the live repository; all "missing" claims are genuine absences of routes/pages/UI, not assumptions.