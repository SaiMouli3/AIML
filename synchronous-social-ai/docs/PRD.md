> Source: *Synchronous Social AI — Product Requirements Document v1.0* (21 Oct 2026), supplied by Synchronous Consulting and converted to Markdown. Implementation status is tracked in `README.md` and `docs/runbook.md`.

**SYNCHRONOUS SOCIAL AI**

Product Requirements Document

AI Marketing Operating System | Version 1.0 | 21 October 2026

Prepared for Synchronous Consulting

# Synchronous Social AI — AI Marketing Operating System

**Version:** 1.0

**Date:** 21 October 2026

**Status:** Product definition for implementation planning

**Product owner:** Synchronous Consulting

# 1. Executive summary

Synchronous Social AI is a multi-tenant AI marketing operations platform
that helps a business plan, create, approve, publish, promote, and
measure its social marketing from one workspace. The first supported
channel is Instagram, with Meta advertising integrations where the
customer's account and permissions support them.

The customer describes their company once: products and services, ideal
customers, regions, positioning, brand voice, claims they can
substantiate, visual identity, offers, business goals, and constraints.
The platform builds a governed company knowledge base and uses
specialist agents to produce and execute marketing work.

The product is not merely a post generator or a chat interface. It is a
workflow and control plane for marketing work: specialist agents
collaborate, work is represented as inspectable artifacts, external
actions pass through explicit permission and approval checks, and every
important action has an audit trail.

**Core promise:** “Tell us what your business wants to achieve. Your AI
marketing team plans the work, prepares it, shows you exactly what will
happen, and executes only within the permissions you approve.”

## Product principles

1.  **Approval before consequential action.** By default, publishing
    content, sending outbound messages, launching ads, changing budgets,
    and applying promotions require explicit approval. A tenant can
    enable narrow, bounded auto-execution policies later.

2.  **Grounded in company truth.** Agents use approved brand facts,
    product data, policies, campaign rules, and source references. They
    must not invent product features, prices, testimonials, discounts,
    or performance claims.

3.  **Human-readable plans.** Before execution, show a plan,
    affected accounts/audiences, assets, spend, timing, assumptions, and
    expected actions.

4.  **Safe autonomy, not blind autonomy.** Agents can research,
    draft, analyze, create variants, and prepare changes without
    approval; irreversible or externally visible actions require policy
    checks.

5.  **Real integrations only.** A connected provider is marked
    available only after credentials, permissions, account access, and a
    live capability check succeed. Never fake successful publishing or
    ad deployment.

6.  **Modular provider architecture.** Instagram, Meta Marketing
    API, media generation, LLMs, analytics, and CRM providers sit behind
    adapters.

7.  **Enterprise-grade foundations.** Tenant isolation, RBAC, audit
    logs, encrypted secrets, background jobs, observability, rate
    limits, retries, and tested failure handling are first-class
    requirements.

# 2. Problem statement

Businesses coordinate social content, customer replies, offers, ad
campaigns, creative production, and reporting across disconnected tools.
Teams lose time translating business context into briefs, repeatedly
producing content, replying to common questions, updating campaigns, and
determining what worked. Existing tools may schedule content or generate
copy, but the desired experience is a governed agent team that can carry
work from business intent to reviewed execution.

# 3. Target customers and users

## Initial customer segments

- Small and mid-sized businesses with active Instagram presence.

- Direct-to-consumer and e-commerce brands.

- Service businesses, clinics, education businesses, hospitality, and
  local multi-location brands, subject to industry-specific policy
  checks.

- Marketing agencies managing multiple client brands.

- Enterprise marketing teams needing approvals, auditability, and
  account-level permissions.

## User roles

- **Workspace owner:** billing, workspace settings, integrations,
  security, policies.

- **Admin:** manages company profile, users, channels, approval
  rules, and campaigns.

- **Marketing manager:** creates plans, reviews creative, manages
  campaigns, sees analytics.

- **Creator/operator:** prepares drafts and assets, responds to
  assigned work.

- **Approver:** approves or rejects specified action types.

- **Analyst:** read-only access to performance, reports, and
  recommendations.

- **Agency operator:** manages only explicitly assigned client
  workspaces.

- **Auditor:** read-only access to audit history and policy
  decisions.

# 4. Goals and non-goals

## Goals

- Onboard a business and create an actionable company knowledge profile.

- Provide a coordinated set of specialist marketing agents with a
  shared, permissioned workspace.

- Create Instagram-ready image, carousel, caption, story/reel assets
  where API capabilities permit.

- Generate short-form video using connected providers such as
  Higgsfield, with an extensible provider interface.

- Manage Instagram publishing and eligible messaging capabilities
  through official, permissioned Meta APIs.

- Prepare, launch, pause, and report on Meta ad campaigns through the
  official Marketing API when account permissions permit.

- Support promotion workflows such as “50% off for three days” with a
  reviewable campaign plan and consistency checks.

- Require approval before public posting, outbound messaging, ad launch,
  budget changes, or discount activation unless an explicit bounded
  policy authorizes the exact action.

- Measure campaign outcomes and turn results into recommendations
  without promising guaranteed performance.

- Offer an enterprise-grade UI, observability, and secure deployment.

## Non-goals for the first release

- Unrestricted autonomous access to personal Instagram accounts.

- Scraping private data or bypassing Meta API restrictions.

- Sending bulk unsolicited DMs or automating spam.

- Guaranteed “perfect” targeting, virality, ROAS, or conversion
  outcomes.

- Automatically changing product prices or applying discounts inside
  commerce systems without an explicit commerce integration and separate
  authorization.

- Building a general-purpose video editor comparable to a full
  professional editing suite.

- Supporting every social network on day one.

- Training a proprietary foundation model.

# 5. Product scope and release plan

## MVP — Instagram marketing workspace

8.  Workspace and company onboarding.

9.  Brand knowledge profile and source documents.

10. Instagram professional account connection through supported Meta
    authorization flows.

11. Content calendar and post/reel draft workflow.

12. AI copy and creative briefing.

13. Image upload and generated media storage.

14. Higgsfield adapter behind a feature flag, using verified API
    documentation and server-side credentials.

15. Approval queue with preview and action summary.

16. Instagram publishing only for media types and account configurations
    officially supported by the connected API.

10. Basic comments/DM inbox capabilities only where official
permissions and account eligibility allow them.

11. Audit log, usage/cost tracking, and clear integration status.

12. Mock providers for local development, visibly labeled as mocks and
never represented as live actions.

## Release 2 — Campaign and customer operations

- Meta Marketing API campaign creation and management.

- Promotion workflow with date boundaries, offer terms, exclusions,
  landing page, and channel consistency.

- Customer segments and existing-customer outreach through
  consented/eligible channels.

- DM intent classification, reply suggestions, handoff, FAQs, lead
  capture, and CRM sync.

- Analytics dashboards and campaign reports.

- Scheduled recurring workflows and bounded automation policies.

## Release 3 — Advanced marketing intelligence

- Cross-campaign experiment planning and creative variants.

- Product catalog/commerce integration where authorized.

- Multi-location brand governance.

- Agency client workspaces and white-label options.

- Additional channels through adapter architecture.

- Predictive recommendations based on sufficient customer data, with
  confidence and limitations shown.

# 6. Core user journeys

## Journey A: First-time onboarding

17. User creates a workspace and invites teammates.

18. User enters company name, website, products/services, markets,
    customer segments, objectives, differentiators, approved claims,
    forbidden claims, brand tone, visual assets, pricing, and policies.

19. User uploads brand guidelines, product catalog, FAQs, testimonials
    with permissions, offer terms, and campaign materials.

20. System extracts structured facts and creates a source-linked
    knowledge base.

21. User reviews conflicts, uncertain facts, and missing information.

22. User connects Instagram and Meta business assets through official
    authorization.

23. System displays granted scopes, account identity, available
    capabilities, missing permissions, and token status.

24. User sets approval rules and optional spend limits.

25. System produces a first 30-day content plan for review.

## Journey B: Create and publish a post

26. User asks: “Create a post introducing our new product for small
    business owners.”

27. Orchestrator creates a plan and delegates audience/positioning,
    copy, and creative tasks.

28. Agents generate caption, CTA, hashtags where useful, image/video
    brief, accessibility text, and variants.

29. System validates the result against brand rules, claims, policy,
    asset dimensions, and channel constraints.

30. User sees a preview, caption, intended account, media type,
    scheduled time, and any warnings.

31. User approves, requests edits, or rejects.

32. Approval is bound to the exact content version and action. Any
    material edit invalidates the prior approval.

33. A publishing worker checks token, account, permissions, media
    readiness, rate limits, and idempotency before publishing.

34. System stores provider response, permalink/media ID where available,
    timestamp, and audit event.

10. Failures become actionable tasks; the system never reports success
without a confirmed provider response.

## Journey C: “Run 50% off for three days”

35. User enters the offer in natural language.

36. System parses discount, products, start/end time, timezone,
    eligibility, exclusions, stock/availability caveats, landing page,
    audience, and channels.

37. If key details are missing, ask concise questions before creating
    externally visible actions.

38. Promotion agent creates a campaign plan: feed post, reel/story
    concepts, captions, landing-page copy suggestion, customer message
    draft, and proposed Meta ad campaign.

39. A consistency checker validates the same offer terms across every
    asset.

40. The user reviews the offer and the full execution plan, including ad
    budget, audience, placements, dates, and destination URL.

41. Separate approvals are required for public organic content, customer
    messages, and paid ads. Approval of one does not imply approval of
    the others.

42. The system schedules approved assets and creates approved ads only
    through supported APIs.

43. The system pauses or ends time-bound actions at the correct
    timezone-aware boundary where API support permits; it also runs
    reconciliation jobs and alerts on failures.

10. The system reports outcomes and never invents unavailable
conversion data.

## Journey D: Customer message management

44. Incoming eligible messages appear in a unified inbox.

45. AI classifies intent, sentiment, urgency, language, lead status, and
    confidence.

46. It drafts a response grounded in approved FAQs and company data.

47. Low-risk reply suggestions can be shown to an agent; auto-reply is
    disabled by default and only enabled for narrowly defined intents
    after configuration.

48. Complaints, refunds, legal issues, safety issues, sensitive topics,
    low confidence, or pricing exceptions are escalated.

49. Outbound campaign messages are sent only where channel policies,
    user consent, legal requirements, and official API permissions allow
    them. Instagram messaging is not treated as an unrestricted
    marketing blast channel.

50. All messages, classifications, actions, and handoffs are auditable.

## Journey E: Generate a cinematic reel

51. User uploads product images or provides a concept.

52. Creative agent proposes a storyboard, shot list, on-screen text,
    voice-over, music/audio guidance, aspect ratio, duration, and
    prompt.

53. User selects a provider/model and sees estimated credits/cost where
    available.

54. The media provider adapter submits a generation job asynchronously.

55. Worker tracks status and stores the resulting asset in controlled
    object storage.

56. System runs checks for aspect ratio, duration, resolution,
    prohibited content, brand consistency, and missing/corrupt output.

57. User previews the reel and caption, edits if needed, and approves
    the exact asset version.

58. Publishing occurs only after approval and platform eligibility
    checks.

# 7. Specialist agent design

Agents are logical roles orchestrated by a central workflow engine. They
are not independent authorities that can bypass policy enforcement.

## 7.1 Marketing strategist agent

- Interprets business goals, products, target segments, markets, and
  constraints.

- Proposes positioning, content pillars, campaign calendar, and channel
  strategy.

- Cites the company facts and performance evidence used.

- Outputs structured plans with assumptions, confidence, risks, and
  required approvals.

## 7.2 Company knowledge agent

- Ingests website pages and uploaded documents only with authorization.

- Extracts products, services, audience, brand voice, claims, FAQs,
  offer terms, and exclusions.

- Preserves source references, timestamps, and confidence.

- Flags contradictory facts for human resolution; does not silently
  choose between conflicting prices or terms.

## 7.3 Audience and research agent

- Builds audience hypotheses from first-party/authorized data, campaign
  performance, and user-supplied market research.

- Uses permitted Meta targeting options only.

- Does not infer or target sensitive personal attributes or exploit
  protected characteristics.

- Explains why a segment is proposed and labels hypotheses as
  hypotheses.

- Never claims exact or perfect targeting.

## 7.4 Content and copy agent

- Generates captions, hooks, CTAs, carousel outlines, story sequences,
  alt text, and localized variants.

- Uses only approved facts and current promotion terms.

- Avoids fabricated testimonials, false scarcity, unsupported
  guarantees, or deceptive claims.

- Outputs content in structured, versioned artifacts.

## 7.5 Creative director agent

- Converts the campaign brief into image/video prompts, storyboards,
  composition rules, visual identity constraints, and asset
  specifications.

- Keeps product appearance and logos faithful where possible.

- Tracks source assets and their rights/consent metadata.

## 7.6 Media generation agent

- Selects from configured provider adapters such as Higgsfield and any
  approved fallback.

- Estimates costs where provider data supports it.

- Uses asynchronous jobs, retry policies, cancellation, and result
  validation.

- Never pretends a generation succeeded if it failed or returned an
  unusable asset.

## 7.7 Community inbox agent

- Classifies inbound conversations and suggests grounded responses.

- Recognizes lead enquiries, order/support issues, complaints, spam, and
  escalation triggers.

- Supports human handoff and conversation ownership.

- Does not send outbound messages outside the permitted window or
  available API capability.

## 7.8 Ads strategist agent

- Proposes campaign objective, audience hypothesis, creative variants,
  placements, schedule, budget, and conversion event.

- Checks pixel/dataset, destination, tracking, and billing
  prerequisites.

- Produces a costed proposal; it cannot launch or increase spend without
  approval or an explicitly configured bounded policy.

## 7.9 Ads operations agent

- Creates/updates/pauses approved campaigns through Meta Marketing API.

- Enforces per-campaign and workspace spend caps, change thresholds,
  idempotency, and audit logging.

- Does not bypass Meta review, delivery rules, account restrictions, or
  permissions.

## 7.10 Analytics and learning agent

- Summarizes available reach, impressions, engagement, clicks, leads,
  purchases, cost, and conversion metrics.

- Separates measured facts from estimates and recommendations.

- Avoids causal claims from weak data.

- Proposes experiments and changes for approval.

## 7.11 Compliance and quality agent

- Checks brand voice, approved claims, offer consistency, prohibited
  content, copyright/consent metadata, channel constraints,
  accessibility, and policy risks.

- Returns pass, warning, or block with reasons.

- A block cannot be overridden by an ordinary content-generation agent;
  only a designated authorized user can resolve a documented policy
  block where legally permissible.

# 8. Agent orchestration and tool boundaries

Use a durable workflow engine or job system with explicit workflow
states, not unbounded recursive agent loops.

## Standard workflow

`REQUESTED → PLANNING → DRAFTING → VALIDATING → AWAITING_APPROVAL →
APPROVED → QUEUED → EXECUTING → SUCCEEDED`

Alternative terminal states: `REJECTED`, `CANCELLED`, `FAILED`,
`EXPIRED`, `NEEDS_INPUT`.

## Tool permission tiers

- **Tier 0 — Read:** read company knowledge, analytics, and
  authorized provider metadata.

- **Tier 1 — Draft:** create internal drafts, plans, and assets.

- **Tier 2 — Reversible internal changes:** edit drafts, calendars,
  and internal CRM notes.

- **Tier 3 — External public actions:** publish posts, send
  messages, change live campaigns.

- **Tier 4 — Financially consequential actions:** launch ads,
  increase budgets, change bids or spend caps, activate discounts or
  commerce changes.

Tier 3 and Tier 4 require approval by default. A policy may allow a
narrow action only when it specifies permitted action type, account,
content/category, time window, spend ceiling, recipient eligibility, and
revocation method. The platform must not let an agent create its own
permissions.

# 9. Functional requirements

## FR-1 Workspace and identity

- Multi-tenant workspace model with isolated data and storage prefixes.

- Authentication, session management, invitations, MFA-compatible
  architecture, and optional enterprise SSO in a later phase.

- RBAC at workspace, connected account, campaign, and action level.

- Every API request verifies tenant and role authorization server-side.

## FR-2 Company profile and knowledge

- Structured company profile with products/services, pricing,
  differentiators, target markets, customer personas, approved claims,
  prohibited claims, brand tone, visual guidelines, and business goals.

- Document ingestion with file-type/size limits, malware scanning,
  extraction, source references, versioning, and deletion support.

- Retrieval with citations/source links where available.

- User review for ambiguous or contradictory facts.

- Company knowledge must be tenant-scoped and never used to train shared
  models without explicit, separate consent.

## FR-3 Content studio

- Calendar views: month, week, list; filters by account, campaign,
  status, and content type.

- Draft post, carousel, story/reel concept, caption, hashtags, alt text,
  CTA, language, and target segment.

- Asset upload, crop/preview, versioning, and source-rights metadata.

- Reusable brand templates and campaign briefs.

- Content variants and revision history.

- Preview must distinguish generated mock preview from final
  platform-rendered appearance.

## FR-4 Approval center

- Approval cards show exact copy, exact media, account,
  date/time/timezone, intended audience where relevant, ad budget,
  destination, and side effects.

- Approvals bind to immutable content/action versions.

- Any material edit, changed destination, changed audience, changed
  budget, or changed timing invalidates approval.

- Support approve, reject with reason, request changes, delegate,
  expire, and revoke before execution.

- Approval policies configurable by action category and threshold.

- Audit all approval decisions.

## FR-5 Instagram integration

- Use the official Meta authorization and Instagram API capabilities
  supported for the connected account type.

- Capability discovery must show publishing, media types, comments,
  messaging, insights, and account details separately.

- Handle access-token expiry, permission revocation, account disconnect,
  rate limits, media-processing states, and API errors.

- Publish only supported media types and formats according to current
  official docs.

- Store provider IDs and returned permalink where available.

- Do not scrape Instagram or use unofficial login automation.

- Messaging features must honor platform rules and eligibility; no
  generic bulk-DM feature.

## FR-6 Meta ads integration

- Use the official Meta Marketing API.

- Read account, campaigns, ad sets, ads, creatives, targeting options,
  billing/readiness signals, and insights only as permissions allow.

- Draft campaign structure before creation.

- Validate objective, conversion event, destination, creative,
  targeting, budget, schedule, special ad category, and tracking
  prerequisites.

- Launch/pause/update only after approval or bounded policy
  authorization.

- Apply hard spend ceilings and a kill switch.

- Treat platform review and delivery status as provider-controlled.

- Reconcile desired state with actual state and alert when they differ.

## FR-7 Promotions

- Structured offer object: title, discount type/value, eligible
  products, exclusions, start/end time, timezone, redemption
  instructions, landing page, stock/availability note, customer
  eligibility, legal terms, and approval status.

- Cross-asset consistency validation.

- Require separate approvals for organic content, outbound messaging,
  ads, and commerce-system changes.

- Expire scheduled actions and trigger reconciliation at campaign end.

- Never imply that the platform changed prices or applied a coupon
  unless a connected commerce API confirms it.

## FR-8 Messaging and CRM

- Unified inbox for supported incoming conversations and comments.

- Intent classification, reply drafts, assignment, SLA timers, notes,
  labels, escalation, and conversation history.

- CRM integration via provider adapters; initial version may support one
  selected CRM plus CSV export/import if needed.

- Outbound communication gated by consent, platform rules, legal
  requirements, and recipient eligibility.

- Deduplication and idempotency for messages and contact sync.

- Human takeover immediately disables automation for the assigned
  conversation until released.

## FR-9 Media generation

- Provider-neutral interface for image/video generation, starting with
  Higgsfield where access is available.

- Verify current official model endpoint, input schema, upload flow,
  polling/webhooks, output URLs, rate limits, and pricing before
  implementing.

- Store credentials server-side only.

- Asynchronous job queue, timeout, retry/backoff, cancellation where
  supported, status, usage cost, and failure reason.

- Generated output copied to tenant-controlled object storage before
  provider URLs expire, where permitted by provider terms.

- Never log signed URLs or credentials.

- Provider unavailability must not break the rest of the application.

## FR-10 Analytics

- Dashboard for published content, reach, impressions, engagement,
  clicks, leads, conversions, ad spend, CPM, CPC, CTR, CPA, and ROAS
  where data is available.

- Clearly show source, reporting window, currency, attribution window,
  and missing-data caveats.

- No invented or silently imputed metrics.

- Export CSV and scheduled PDF/report delivery in a later release.

- Agent recommendations must link back to observed evidence.

## FR-11 Automation rules

- User-created triggers such as new product, campaign start, low stock
  event from an integration, scheduled calendar slot, or incoming
  message.

- Rule includes trigger, conditions, actions, approvals, limits,
  schedule, timezone, failure behavior, and owner.

- Preview/test mode before activation.

- Pause, disable, version, and audit every rule.

- Prevent duplicate execution through idempotency keys and durable job
  state.

## FR-12 Notifications

- In-app notifications for approvals, failures, token expiry, ad budget
  thresholds, moderation blocks, generation completion, and campaign
  end.

- Email notification adapter; other channels only after explicit
  integration.

- Notification preferences and digest controls.

## FR-13 Billing and usage

- Track model usage, media-generation cost, storage, and billable
  platform usage by tenant.

- Tenant usage limits and budget alerts.

- Never present provider cost estimates as guaranteed final charges.

- Subscription/billing provider integration is a later implementation
  decision; isolate billing logic.

## FR-14 Audit and operations

- Append-only audit events for login/security events, integration
  changes, approvals, external actions, agent tool calls, spend changes,
  and automation rule changes.

- Correlation IDs across web request, workflow, agent run, provider
  call, and audit event.

- Operator view for failed jobs, retry eligibility, provider health,
  queue depth, token status, and tenant-level usage.

- PII redaction and configurable retention.

# 10. Non-functional requirements

## Security and privacy

- Encrypt traffic in transit and sensitive data at rest.

- Store provider secrets in a managed secret store or encrypted
  server-side vault; never in client bundles or logs.

- Validate OAuth state and redirect URIs; use least-privilege scopes.

- Secure file upload with MIME/content verification, malware scanning,
  signed short-lived URLs, and access checks.

- Prevent prompt injection from uploaded documents, websites, DMs, and
  comments from overriding system policies or triggering tools.

- Treat retrieved text as untrusted input. Tool execution uses
  allowlists and server-side authorization.

- Tenant isolation enforced in queries, storage, jobs, caches, vector
  retrieval, and logs.

- Data export/deletion and retention controls.

- Privacy and compliance review before launch in each market.

## Reliability

- Durable background jobs with retries, exponential backoff, jitter,
  dead-letter handling, and manual replay controls.

- Idempotency for publishing, messaging, ads, and external mutations.

- Never retry a non-idempotent external action blindly if provider
  outcome is uncertain; reconcile first.

- Timezone-aware scheduling, daylight-saving handling, and campaign
  boundary tests.

- Health checks, structured logs, metrics, tracing, error reporting, and
  alerts.

- Graceful degradation when an AI or media provider is down.

## Performance targets

- Typical dashboard read p95 under 500 ms excluding external provider
  latency, subject to deployment and data size.

- Internal draft workflow should stream progress and provide a clear job
  status.

- All long-running media generation and external API tasks run
  asynchronously.

- Targets must be load-tested; do not claim they are met without
  measurements.

## Accessibility and UX

- Responsive mobile, tablet, and desktop layout.

- Keyboard navigation, focus visibility, semantic forms, screen-reader
  labels, sufficient contrast, and reduced-motion support.

- Clear loading, empty, error, partial-success, and disconnected states.

- Confirm destructive actions and show exact effects before execution.

# 11. Enterprise-grade UX specification

## Primary navigation

- Overview

- AI Team

- Content Studio

- Calendar

- Inbox

- Campaigns & Ads

- Media Library

- Analytics

- Company Brain

- Approvals

- Automations

- Integrations

- Team & Permissions

- Settings / Usage

## Overview dashboard

- Today’s plan and tasks.

- Items awaiting approval.

- Scheduled content and campaign milestones.

- Active ads and spend pacing.

- Inbox volume and unanswered conversations.

- Recent results and recommendations.

- Integration health and token-expiry warnings.

- Agent activity timeline with status, not a fake live animation.

## AI Team screen

- Specialist cards with role, status, permitted tools, current task,
  last run, and cost.

- Run history and inspectable outputs.

- Pause/resume agent workflows.

- Agents may not edit their own access policies.

## Content Studio

- High-quality preview canvas with Instagram-like format previews.

- Caption editor, asset versions, brand checks, accessibility checks,
  platform warnings, and “request changes”.

- One-click “prepare for approval”; never one-click publish unless a
  bounded policy is active and clearly displayed.

## Approval center

- Prioritized queue with action severity and deadline.

- Side-by-side preview and action summary.

- For ads: budget, currency, duration, audience, placements, objective,
  destination, and tracking.

- For messages: recipients/segment, count estimate if available,
  eligibility, message copy, and opt-out/consent context.

- Approver can approve only actions they are authorized to approve.

## Design direction

- Premium B2B SaaS, restrained and clear, not a generic chat wrapper.

- Consistent spacing and typography, strong information hierarchy,
  polished data tables, helpful empty states, clear status colors, and
  real product preview components.

- Use a shared design system and reusable components.

- Avoid fabricated metrics, decorative fake charts, and buttons that do
  nothing.

# 12. Data model (initial)

Recommended relational entities:

- `users`, `workspaces`, `workspace_memberships`, `roles`,
  `permissions`

- `company_profiles`, `knowledge_sources`, `knowledge_documents`,
  `knowledge_chunks`, `brand_rules`

- `integrations`, `connected_accounts`, `oauth_grants`,
  `secret_references`, `provider_capabilities`

- `agents`, `agent_runs`, `agent_messages`, `tool_invocations`

- `campaigns`, `promotion_offers`, `content_items`,
  `content_versions`, `media_assets`, `media_generation_jobs`

- `approval_requests`, `approval_decisions`, `automation_rules`,
  `scheduled_jobs`

- `inbox_conversations`, `inbox_messages`, `contact_records`,
  `crm_sync_events`

- `ad_campaigns`, `ad_sets`, `ad_creatives`,
  `ad_action_requests`, `ad_metrics_snapshots`

- `audit_events`, `usage_events`, `notifications`,
  `webhook_events`, `provider_sync_states`

Every tenant-owned row must carry `workspace_id` or a validated path
to a workspace. Add indexes for tenant filtering and time-ordered
activity. Use migrations and foreign keys. Use immutable/versioned
records for content and approval decisions.

# 13. Architecture recommendation

Use a modular monolith first, with worker processes and provider
adapters. Avoid premature microservices, but keep boundaries clean
enough to split later.

## Suggested stack

- **Frontend:** Next.js + TypeScript, React, accessible component
  system, Tailwind CSS, React Query or equivalent.

- **Backend:** TypeScript API using a well-supported framework (e.g.
  NestJS or Next.js server/API boundary) with explicit service layers.

- **Database:** PostgreSQL with migrations and tenant-safe query
  patterns.

- **Vector retrieval:** pgvector or a managed vector store, isolated
  by tenant and source permissions.

- **Queue/workflows:** Temporal, Inngest, or a durable queue such as
  BullMQ with Redis; select one and implement retries/idempotency
  properly.

- **Object storage:** S3-compatible storage for source/generated
  media, with signed URLs.

- **Authentication:** Managed auth or a well-reviewed auth library;
  RBAC enforced on server.

- **Observability:** structured logs, OpenTelemetry-compatible
  traces/metrics, error monitoring.

- **AI layer:** provider abstraction for LLMs with structured output
  schemas, tool allowlists, budget limits, and evaluation tests.

- **External APIs:** official Meta APIs and provider adapters. No
  browser scraping for unsupported functions.

- **Deployment:** Docker, managed PostgreSQL, object storage, secret
  manager, queue workers, CI/CD, backups, and rollback strategy.

## High-level flow

`Web app → authenticated API → policy/permission service → durable
workflow → specialist agents → approved tools/adapters →
Meta/Higgsfield/CRM providers`

The database records state and audit events; the queue runs long tasks;
object storage stores media; observability tracks every workflow and
provider call.

# 14. API surface (illustrative)

- `POST /api/workspaces`

- `GET/PATCH /api/workspaces/:id/company-profile`

- `POST /api/knowledge/sources`

- `POST /api/integrations/meta/connect`

- `GET /api/integrations/:id/capabilities`

- `POST /api/content/plan`

- `POST /api/content/drafts`

- `PATCH /api/content/:id`

- `POST /api/content/:id/request-approval`

- `POST /api/approvals/:id/approve`

- `POST /api/approvals/:id/reject`

- `POST /api/media/generations`

- `GET /api/media/generations/:id`

- `POST /api/promotions`

- `POST /api/campaigns/plan`

- `POST /api/campaigns/:id/request-launch-approval`

- `POST /api/inbox/:conversationId/draft-reply`

- `POST /api/automation-rules`

- `POST /api/automation-rules/:id/test`

- `POST /api/automation-rules/:id/enable`

- `GET /api/analytics/overview`

- `GET /api/audit-events`

All routes require authentication and authorization. Validate inputs
with schemas, enforce tenant boundaries, apply rate limits, and return
stable error contracts.

# 15. Analytics and success metrics

## Product activation

- Percentage of new workspaces completing company profile.

- Percentage connecting an eligible Instagram account.

- Time to first approved and successfully published post.

- Percentage of users completing a campaign plan.

## Workflow quality

- Draft acceptance rate and number of revision cycles.

- Media generation success rate.

- Approval turnaround time.

- External action success/failure rate.

- Duplicate-action incidents (target: zero).

- Agent escalation rate and policy-block rate.

## Business value

- Time saved per campaign.

- Time to respond to eligible inbound messages.

- Content production cost per approved asset.

- Ad spend pacing and budget-limit incidents.

- Leads/conversions and cost metrics where valid tracking is available.

- Retention, expansion, and gross margin by tenant.

Do not optimize for post volume alone. The product must show business
value and safe execution.

# 16. Acceptance criteria for MVP

59. A user can create a workspace, invite a teammate, and enforce role
    permissions.

60. A user can complete a company profile and upload source material;
    extracted facts show provenance and can be corrected.

61. A user can connect an eligible Instagram professional account using
    official Meta authorization and see actual granted capabilities.

62. A user can request a post/reel draft and inspect caption, media,
    source facts, warnings, and version history.

63. A reviewer can approve or reject the exact version; editing the
    version invalidates the approval.

64. Publishing cannot happen without approval or a valid bounded
    automation policy.

65. Publishing result is based on the provider response; failures are
    visible and recoverable.

66. A media generation job can be queued, tracked, cancelled where
    supported, and retried safely.

67. Integration secrets never appear in frontend bundles, client logs,
    or application logs.

10. Tenant A cannot read or mutate Tenant B’s content, files, vectors,
jobs, integrations, or audit records.

11. Every consequential action creates an audit event with actor,
approval, provider, result, timestamp, and correlation ID.

12. Mock integrations are clearly labeled and cannot be confused with
production execution.

13. Core flows have unit, integration, authorization, and end-to-end
tests.

14. The UI works on mobile and desktop and includes loading, empty,
error, disconnected, and partial-success states.

# 17. Risk register and mitigations

| Risk                                               | Mitigation                                                                                         |
|----------------------------------------------------|----------------------------------------------------------------------------------------------------|
| Meta permissions or API eligibility limit features | Capability discovery, official docs verification, clear unavailable states, app review plan        |
| API changes or rate limits                         | Versioned adapters, provider contract tests, backoff, reconciliation                               |
| Wrong offer or invented product claim              | Source-grounded generation, structured offer object, cross-asset consistency, approval             |
| Accidental public post or ad spend                 | Exact-version approval, hard caps, two-step approval for high-impact actions, kill switch          |
| Spam or policy violation                           | Consent/eligibility checks, rate limits, opt-out support where applicable, no bulk unsolicited DMs |
| Provider cost spikes                               | Per-tenant budgets, estimates, alerts, job limits, admin kill switch                               |
| Prompt injection in messages/documents             | Treat external content as untrusted, tool allowlists, policy service outside agent context         |
| Poor creative quality                              | Preview, multiple variants, user review, brand checks, feedback loop                               |
| Hallucinated analytics                             | Source-backed metrics, missing-data indicators, deterministic calculations                         |
| Multi-tenant data leak                             | Tenant-aware DB access, object-store authorization, RLS where appropriate, security tests          |
| Scheduled task runs twice                          | Idempotency keys, durable state machine, reconciliation before retry                               |
| Copyright/likeness/brand rights                    | Rights metadata, user attestations, provider terms review, escalation for uncertain assets         |

# 18. Implementation milestones

## Milestone 0 — Discovery and technical spike

- Confirm Meta developer app setup, permissions, app review
  requirements, account eligibility, publishing and messaging
  capabilities.

- Confirm Higgsfield API account, credential format, model catalog,
  upload flow, async status handling, costs, terms, and output
  retention.

- Choose auth, queue, storage, hosting, and LLM provider.

- Produce architecture decision records and threat model.

## Milestone 1 — Secure product skeleton

- App shell, auth, workspace, RBAC, database migrations, audit event
  foundation, secrets handling, CI, lint, typecheck, tests.

- Design system and responsive navigation.

## Milestone 2 — Company Brain and Content Studio

- Company profile, document ingestion, source-backed knowledge
  retrieval, content drafts, media library, calendar, versioning.

## Milestone 3 — Approvals and media generation

- Approval state machine, immutable approval binding, provider adapter,
  async jobs, cost tracking, mock provider, initial Higgsfield
  integration.

## Milestone 4 — Instagram integration

- Official OAuth, capability discovery, publishing for eligible content
  types, provider reconciliation, audit trail, error recovery.

## Milestone 5 — Ads and promotion workflows

- Meta Marketing API, draft campaign structures, budget guardrails,
  separate approval flows, promotion object and expiry checks.

## Milestone 6 — Inbox, analytics, and automation

- Supported inbox functions, human handoff, CRM integration, metrics,
  automation rules, reporting.

## Milestone 7 — Production hardening

- Security review, penetration testing, load tests, disaster recovery,
  backup restore test, data deletion/export, alerting, documentation,
  staged rollout.

# 19. Launch checklist

- Meta app review and business verification completed as applicable.

- Production OAuth redirect URIs, scopes, token storage, and revocation
  tested.

- Real account capabilities verified end to end.

- Ads tested in a safe non-spending or draft mode before live launch.

- Spend caps and kill switch verified.

- Approval bypass tests pass.

- Tenant isolation and prompt injection tests pass.

- No secrets in logs, client bundles, source control, or error messages.

- Backup restore and migration rollback tested.

- Privacy policy, terms, data processing disclosures, retention, and
  deletion flows published.

- Provider costs and quotas documented.

- Incident response owner and rollback plan identified.

# 20. Open decisions

68. Which CRM/e-commerce system should be the first integration?

69. Which LLM provider(s) and model budget should be supported at
    launch?

70. Which Meta account types and permissions will be in the first
    approved release?

71. Which billing model: seats, connected brands, usage credits, or
    hybrid?

72. Should the first customer cohort be direct brands or marketing
    agencies?

73. What data retention and regional hosting requirements apply to
    launch customers?

74. What degree of bounded auto-execution is permitted after trust is
    established?

# 21. External references to verify during implementation

- Meta for Developers, Instagram Platform:
  https://developers.facebook.com/docs/instagram-platform/

- Meta for Developers, Marketing API:
  https://developers.facebook.com/docs/marketing-api/

- Higgsfield API documentation: https://docs.higgsfield.ai/

- Higgsfield API quick start: https://open.higgsfield.ai/quick-start

Provider capabilities, scopes, eligibility, API contracts, pricing, and
terms change. Verify the current official documentation and
account-specific permissions before implementing or promising a feature.

# 22. Comment-to-DM conversion and community sales workflows

This capability is a core product feature, not a generic inbox add-on.

## Use case

When someone comments on a connected Instagram professional account's
post or Reel with buying-intent messages such as “Send me the link”,
“Price?”, or “Where can I buy this?”, the platform detects intent and
helps the business respond with accurate, brand-aligned information.

## Workflow

75. Receive comment events through supported official Meta webhooks and
    verify webhook signatures.

76. Deduplicate events using provider event/comment IDs and persist the
    event before processing.

77. Classify intent: product link, price, stock/variant, delivery,
    promotion, purchase intent, support, complaint, spam, or unknown.

78. Resolve the product using post context, product catalog, campaign
    metadata, and Company Brain. If ambiguous, ask for clarification or
    route to a human.

79. Draft a public reply and, when eligible, a separate private reply/DM
    using approved company facts and URLs.

80. Check API capability, permissions, comment age, current
    private-reply rules, duplicate/suppression status, URL allowlist,
    brand claims, and rate limits.

81. Apply workspace policy: approval-required by default, bounded
    auto-reply for approved low-risk intents, or human-only mode.

82. If approval is required, show public and private replies separately.
    Approval of one does not approve the other.

83. Execute only the permitted action through the official API and
    record the provider result.

84. Continue a DM conversation only within current official messaging
    rules and available eligibility; a comment is not unrestricted
    ongoing DM permission.

85. Track handled, sent, replied-to, qualified, escalated, and failed
    states without inventing clicks or sales.

## Configuration

- Per-account toggles for comment monitoring, public reply suggestions,
  private comment replies, and eligible DM auto-replies.

- Per-campaign rules such as sending an approved product link for a
  supported LINK trigger.

- Approved product URLs, FAQs, current prices, variants, stock status,
  delivery regions, offer expiry, and escalation contacts.

- Cooldowns, duplicate controls, maximum reply limits, rate limits,
  human handoff, and pause controls.

- Approval modes: approve every response, bounded auto-execution for a
  pre-approved rule, or human-only.

- Logs explaining why an action was sent, blocked, skipped, or
  escalated.

## Safety and platform constraints

- Use only official Instagram/Meta APIs and permissions; never scrape or
  automate the consumer Instagram UI.

- Private comment replies and ongoing conversation replies are separate
  action types with separate eligibility checks.

- Verify current official documentation for eligibility, timing, number
  of replies, permissions, and follow-up messaging rules before
  implementation.

- No unsolicited bulk messaging, repeated spam, or attempts to evade
  platform limits.

- Escalate complaints, refunds, legal issues, sensitive claims, angry
  customers, low-confidence product matches, and requests requiring
  exceptions.

- Use approved URLs only; validate domains and block unknown or
  suspicious links.

- Any material change to message text, recipient, URL, campaign, or rule
  invalidates approval.

- Provide a workspace-wide emergency pause for automated replies.

## Acceptance criteria

86. Repeated webhook delivery does not create duplicate processing or
    messages.

87. Intent classification includes confidence and a human-review
    fallback.

88. Product links come only from the approved catalog.

89. Current API capability and eligibility are checked before a private
    reply.

90. A comment does not grant unrestricted permission for follow-up DMs.

91. Approval binds to exact message text and action type.

92. Automation can be paused immediately.

93. Audit history includes event, classification, selected rule,
    approval, API attempt, result, and failure reason.

94. Tests cover rate limits, duplicate events, missing permissions, and
    expired eligibility.

95. Metrics distinguish drafted, approved, sent, replied-to, escalated,
    and failed messages.
