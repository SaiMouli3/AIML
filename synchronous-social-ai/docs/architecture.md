# Architecture

Synchronous Social AI is a **modular monolith** (Next.js 15 App Router + TypeScript) with a separate
**worker process**, backed by **PostgreSQL** (state, durable queue, rate limits, full-text retrieval) and
**S3-compatible object storage** (local filesystem in development).

```
Browser ──► Next.js (pages + /api/v1 route handlers)
              │  route(): CSRF · session · membership · RBAC · zod · rate limit · correlation id
              ▼
           Services (src/server/services/*)  ──►  Policy engine (src/server/policy)  ◄── no LLM involvement
              │            │                          ▲
              │            └─► Approvals (exact-payload hash binding)
              ▼
           PostgreSQL (RLS per workspace) ◄──── Worker (src/worker) claims jobs with FOR UPDATE SKIP LOCKED
                                                   │
                                                   ├─► Agent orchestrator (bounded, schema-validated LLM calls)
                                                   └─► Provider adapters: Instagram · Meta Marketing · Higgsfield · LLM gateway · storage
```

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| HTTP | `src/server/http/handler.ts`, `src/app/api/v1/**` | Versioned routes. Every route goes through `route()` which enforces CSRF (custom header + Origin), session auth, workspace membership, permission, zod validation, per-user rate limits, a tenant-scoped transaction and the stable error contract `{ error: { code, message, details }, correlationId }`. |
| Pages | `src/app/(app)/**` | Server components load data through `loadPage()` (same session/tenant rules) and pass serialized data to client components. Mutations call `/api/v1`. |
| Services | `src/server/services/*` | Domain logic. Every function takes a `Ctx` (`workspaceId`, `userId`, `role`, `actorType`, `tx`, `correlationId`) and filters by `workspace_id` explicitly. |
| Policy | `src/server/policy/policy.ts` | Pure functions: action → tier, `evaluateAction()` (kill switch, account status, approval validity + payload hash, bounded automation policies), `checkSpendCap()`, two-person thresholds, agent tool allowlists. |
| Approvals | `src/server/services/approvals.ts` | Subject registry: each approvable action registers a `build()` that derives the exact payload from DB state. The SHA-256 of canonical JSON is stored; the same builder runs at decision time and again in the executor. |
| External actions | `src/server/services/external-actions.ts` | `runExternalAction()` — unique idempotency key per intended action, authorize→execute→record in separate commits, `unknown` outcomes reconciled (or left for a human), never blindly retried. |
| Queue | `src/server/queue/*` | Postgres job table, SKIP LOCKED claims, per-tenant concurrency, exponential backoff with jitter, dead-letter, stale-lock recovery, kill-switch hold for external job types, periodic scheduler with time-bucketed idempotency keys. |
| Agents | `src/server/agents/*` | 11 role contracts + orchestrator state machine (`REQUESTED → PLANNING → DRAFTING → VALIDATING → …`). |
| Providers | `src/server/providers/*` | Adapter interfaces with live implementations and clearly-labelled development mocks. |

## Tenant isolation (defense in depth)
1. Every tenant table has `workspace_id` (FK, indexed) and **row-level security forced** (`drizzle/0001_rls_and_search.sql`). `withTenant()` sets `app.workspace_id` per transaction; system code paths use `withSystem()` (sets `app.rls_bypass`) with explicit filters.
2. Services filter by `ctx.workspaceId` and verify ownership of every referenced id.
3. Object keys are `<workspaceId>/<category>/<uuid>.<ext>`; signed URLs are short-lived.
4. Knowledge retrieval (`websearch_to_tsquery` over a generated `tsvector`) is filtered by workspace.
The app **must connect as a non-superuser role** (superusers bypass RLS).

## Agent orchestration
- Planning gathers Tier-0 grounding (approved facts, catalog, brand rules, allowlisted domains, retrieved excerpts, promotion terms, metrics) and records every `tool_invocation` (denied ones are audited).
- Drafting makes at most `maxSteps` calls to the LLM gateway with JSON-schema structured output; invalid output gets one repair prompt.
- Validating applies the zod schema and contract `postValidate` (e.g. strip sensitive targeting, drop facts whose excerpt is not in the source, discard analytics findings without data, forbid invented budgets).
- Results: `SUCCEEDED` or `NEEDS_INPUT` (escalation reasons). Agents produce drafts only; Tier 3/4 always go through approvals + the policy engine. Cost/tokens/latency are stored per run and as `usage_events`; monthly LLM budgets are enforced before a run.
- Untrusted content (DMs, comments, documents) is wrapped in `<untrusted>` delimiters with an explicit data-only policy; detection heuristics flag injection-like text but **the control is that no privileged tool exists for agents**.

## Comment-to-DM pipeline
`POST /api/v1/webhooks/meta` → HMAC verify → normalize (Instagram-Login and Facebook-Login shapes, messaging) → persist `webhook_events` (unique `(provider, event_key)`; duplicates counted, not reprocessed; echoes ignored) → enqueue `inbox.process_event` (idempotent per account+event) → contact/conversation/message upserts → rule-based intent classification (+ optional `community_manager` LLM refinement; safety classes cannot be downgraded) → product resolution (post-linked products, then name/keyword; ambiguity escalates) → reply planning from verified catalog data (templates; LLM text only if it passes grounding checks) → eligibility (capability, 7-day window, one private reply per comment, opt-out/suppression, takeover, hourly limits; DMs need an inbound DM within 24h) → rule matching (trigger, intent, product, account, schedule) → `bounded_auto` sends via policy, otherwise separate approvals for public and private replies → `inbox.send_reply` re-checks everything at send time and keys private replies by comment id.

## Key decisions
See `docs/decisions/` (ADRs): modular monolith, Postgres job queue, session auth, LLM gateway, mocks policy.
