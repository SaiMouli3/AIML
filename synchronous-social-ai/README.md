# Synchronous Social AI

A multi-tenant **AI marketing operating system** for Instagram, Facebook, Threads, X and TikTok (plus Meta ads). A company describes its business once in the **Company Brain**. Specialist AI agents then plan, write and prepare content, draft replies to comments and DMs, and plan promotions and Meta ads. **Every consequential external action needs an approval bound to the exact version, or a narrowly bounded automation rule**, and every step is audited.

> Product spec: [`docs/PRD.md`](docs/PRD.md) · Architecture: [`docs/architecture.md`](docs/architecture.md) · Security: [`docs/security.md`](docs/security.md) · Integrations: [`docs/integrations.md`](docs/integrations.md) · Runbook: [`docs/runbook.md`](docs/runbook.md) · ADRs: [`docs/decisions/`](docs/decisions)

## What's in the box

| Area                          | What works today                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces & team             | Sign-up, multiple workspaces, single-use invite links, 8 roles with server-side RBAC, role-escalation guards, permission matrix UI.                                                                                                                                                                                                                                                                                                                      |
| Company Brain                 | Structured profile with completeness, facts with sources/excerpts and **conflict detection**, approved product catalog (the only source of links/prices in replies), link allowlist, brand rules (approved/forbidden claims, words, disclaimers, voice), uploads (PDF/TXT/MD/CSV/JSON/HTML) with content sniffing + malware-scan hook, tenant-scoped full-text search, agent fact extraction into a review queue.                                        |
| AI Team                       | 11 specialist contracts (purpose, non-goals, schemas, tool allowlist, budgets, timeouts, escalation). Bounded runs through a workflow state machine. Run history with tools, tokens, cost and outputs. Pause per agent. Real LLM via the Experiential Labs gateway (verified), with a labelled mock fallback.                                                                                                                                            |
| Content Studio & Calendar     | Concepts, drafts, carousels, reels and stories. Immutable versions, brand and platform checks, Instagram-style preview, media picker, "Draft with AI", destination and schedule in the workspace timezone, publish history. Month, week and list calendar with promotion windows.                                                                                                                                                                        |
| Approval Center               | Exact preview, destination, channel, schedule and timezone, recipient and audience, budget, landing page, risks and side effects, payload fingerprint. Approve, reject with reason, request changes, revoke. Two-person rule for big budgets. Expiry. Edits invalidate approvals.                                                                                                                                                                        |
| Channels                      | One Integrations page with five channel tiles: **Instagram, Facebook Pages, Threads, X, TikTok**. Every connected account is a destination in Content Studio, with per-channel formats, character limits, media rules and preview. **Copy to channel** turns one post into separate drafts per channel, each approved on its own. Facebook Page comments and Messenger run through the same comment-to-DM assistant as Instagram.                        |
| Publishing                    | Instagram Content Publishing adapter (containers → status → publish), publishing limits, idempotency, reconciliation of ambiguous outcomes, failure recovery.                                                                                                                                                                                                                                                                                            |
| Comment-to-DM sales assistant | Signed webhooks → dedupe → classification → product resolution → grounded public and private replies → eligibility (7-day window, one private reply per comment, 24-hour DM window, opt-out, capability, rate limits) → separate approvals or bounded auto-send rules → re-checked at send time. Inbox tabs: Comments, DMs, Leads, Needs human, Automation paused. Human takeover. Full action history. Funnel metrics with no invented clicks or sales. |
| Promotions                    | Natural-language parsing ("Run 50% off for three days") into a structured offer. Asks for missing details instead of guessing. Coordinated drafts. Consistency checks across assets. Separate channel approvals. End-of-offer enforcement and reconciliation. Never claims a price or coupon change.                                                                                                                                                     |
| Campaigns & Ads               | Meta Marketing API adapter. Validated drafts (objective, destination allowlist, pixel, special categories, sensitive targeting). Hard monthly spend cap checked before the request and again before the mutation. Tier-4 approval. Objects created PAUSED. Test mode by default. Insights sync.                                                                                                                                                          |
| Media Library                 | Uploads with rights and consent metadata. Higgsfield adapter (idempotent submit, polling, webhook, cancel, estimate, copy to tenant storage). Labelled mock placeholder generator.                                                                                                                                                                                                                                                                       |
| Analytics                     | Provider metrics only, each with its source and window. Derived metrics only when inputs exist. Data-gap callouts. Evidence-bound analyst agent.                                                                                                                                                                                                                                                                                                         |
| Automations                   | Comment-to-DM and scheduled-draft rules with versioning, mandatory dry-run before enabling, human-only enablement, limits, schedule and timezone, workspace and per-account pause.                                                                                                                                                                                                                                                                       |
| Operations                    | Emergency kill switch. Usage and budgets (LLM and media). Jobs with retry and cancel. Manual resolution of uncertain external actions. Append-only audit log. JSON export. Workspace deletion.                                                                                                                                                                                                                                                           |

**Live vs adapter-only vs mock:** see the status table in [`docs/integrations.md`](docs/integrations.md). Short version: the LLM gateway is live and verified. The Instagram, Facebook, Threads, X, TikTok, Meta Ads and Higgsfield adapters follow the current official docs but were **not exercised against real accounts** here (no credentials). Mock accounts are clearly labelled MOCK everywhere and cannot exist in staging or production.

## Quick start

Requirements: Node 22+, PostgreSQL 16 (or `docker compose up -d postgres`).

```bash
cd synchronous-social-ai
cp .env.example .env            # fill in what you have; leave the rest empty
npm install
npm run db:migrate
npm run db:seed                 # optional: fictional DEMO workspace (demo@lumen.example / demo password 123)
npm run dev                     # web on http://localhost:3000
npm run worker                  # in a second terminal — runs agents, publishing, inbox, media jobs
```

> The database user must **not** be a superuser, because superusers bypass row-level security. The compose file and CI create a normal role.

To try the full loop locally without any platform: **Integrations → Mock** on any channel tile, then publish a post through the Approval Center. Then use **Inbox → Simulate event** to inject a comment ("Please send me the link").

## Commands

| Command                                                          | Purpose                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev` / `npm run build && npm start`                     | Web app                                                                                                                        |
| `npm run worker`                                                 | Background worker and scheduler                                                                                                |
| `npm run db:generate` / `npm run db:migrate` / `npm run db:seed` | Migrations and demo seed                                                                                                       |
| `npm run lint` · `npm run typecheck` · `npm run format:check`    | Static checks                                                                                                                  |
| `npm test`                                                       | Unit, integration, security and contract tests (needs Postgres, `TEST_DATABASE_URL`)                                           |
| `npm run test:e2e`                                               | Playwright end-to-end and accessibility tests (builds required; set `PLAYWRIGHT_CHROMIUM_PATH` to use a preinstalled Chromium) |
| `npm run check`                                                  | lint + typecheck + format + tests                                                                                              |

## Environment

All variables are documented in [`.env.example`](.env.example). Production requires `APP_ENV=production`, `SESSION_SECRET`, `ENCRYPTION_KEY`, an HTTPS `APP_URL` and `STORAGE_DRIVER=s3`. Mocks are disabled automatically.

## Layout

```
src/app/(app)/*          pages (14 sections) · src/app/api/v1/** versioned API · src/app/api/{health,ready}
src/server/http          route() guard, page loader       src/server/policy   tiers, approvals, spend caps
src/server/services      domain services                  src/server/agents   contracts + orchestrator
src/server/providers     instagram, social/{facebook,threads,x,tiktok}, marketing, higgsfield, llm, storage (+ mocks)
src/lib/channels.ts      shared channel catalog: formats, limits, validation
src/server/queue         Postgres job queue, worker, scheduler
drizzle/                 SQL migrations (schema, RLS, FTS, append-only triggers)
tests/{unit,integration,security,contract,e2e}
```

## Troubleshooting

See the troubleshooting table in [`docs/runbook.md`](docs/runbook.md#troubleshooting). The most common one: agent runs stuck in "Requested" mean the worker isn't running.
