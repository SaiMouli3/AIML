import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Data model. Every tenant-owned table carries `workspace_id` with a foreign key and an index,
 * and is protected by row-level security (see drizzle/0001_rls_and_search.sql).
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const wsRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ───────────────────────────── Identity & tenancy ─────────────────────────────

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
  disabledAt: ts("disabled_at"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the opaque session token; raw token only lives in the cookie
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeWorkspaceId: uuid("active_workspace_id"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  currency: text("currency").notNull().default("USD"),
  isDemo: boolean("is_demo").notNull().default(false),
  killSwitch: boolean("kill_switch").notNull().default(false),
  killSwitchReason: text("kill_switch_reason"),
  killSwitchAt: ts("kill_switch_at"),
  automationPaused: boolean("automation_paused").notNull().default(false),
  monthlyAdSpendCapMinor: bigint("monthly_ad_spend_cap_minor", { mode: "number" }).notNull().default(0),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
});

export interface WorkspaceSettings {
  twoPersonApprovalAdBudgetMinor?: number;
  llmMonthlyBudgetUsd?: number;
  mediaMonthlyBudgetUsd?: number;
  approvalExpiryHours?: number;
  retentionDays?: number;
}

export const memberships = pgTable(
  "workspace_memberships",
  {
    id: id(),
    workspaceId: wsRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_ws_user_uq").on(t.workspaceId, t.userId), index("membership_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    workspaceId: wsRef(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_ws_idx").on(t.workspaceId)],
);

// ───────────────────────────── Company Brain ─────────────────────────────

export const companyProfiles = pgTable("company_profiles", {
  id: id(),
  workspaceId: wsRef().unique(),
  data: jsonb("data").notNull().default({}),
  completeness: integer("completeness").notNull().default(0),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: id(),
    workspaceId: wsRef(),
    kind: text("kind").notNull(), // upload | manual | url
    title: text("title").notNull(),
    status: text("status").notNull(), // uploaded | processing | ready | failed | unsupported | quarantined
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    storageKey: text("storage_key"),
    sha256: text("sha256"),
    scanStatus: text("scan_status").notNull().default("not_scanned"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("ks_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: id(),
    workspaceId: wsRef(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [index("kd_ws_idx").on(t.workspaceId), index("kd_source_idx").on(t.sourceId)],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    workspaceId: wsRef(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    injectionFlag: boolean("injection_flag").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("kc_ws_idx").on(t.workspaceId), index("kc_source_idx").on(t.sourceId)],
);

export const companyFacts = pgTable(
  "company_facts",
  {
    id: id(),
    workspaceId: wsRef(),
    category: text("category").notNull(), // product | pricing | policy | audience | offer | brand | faq | other
    key: text("key").notNull(),
    value: text("value").notNull(),
    sourceId: uuid("source_id").references(() => knowledgeSources.id, { onDelete: "set null" }),
    sourceExcerpt: text("source_excerpt"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("1"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | conflict
    origin: text("origin").notNull().default("user"), // user | agent
    agentRunId: uuid("agent_run_id"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("facts_ws_idx").on(t.workspaceId, t.category), index("facts_key_idx").on(t.workspaceId, t.key)],
);

export const brandRules = pgTable(
  "brand_rules",
  {
    id: id(),
    workspaceId: wsRef(),
    kind: text("kind").notNull(), // approved_claim | forbidden_claim | forbidden_word | required_disclaimer | voice
    text: text("text").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("brand_rules_ws_idx").on(t.workspaceId)],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    workspaceId: wsRef(),
    name: text("name").notNull(),
    sku: text("sku"),
    description: text("description"),
    url: text("url"),
    priceMinor: bigint("price_minor", { mode: "number" }),
    currency: text("currency"),
    variants: jsonb("variants").$type<string[]>().notNull().default([]),
    stockStatus: text("stock_status").notNull().default("unknown"), // in_stock | low | out_of_stock | unknown
    deliveryPolicy: text("delivery_policy"),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("products_ws_idx").on(t.workspaceId)],
);

export const allowedDomains = pgTable(
  "allowed_domains",
  {
    id: id(),
    workspaceId: wsRef(),
    domain: text("domain").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("allowed_domains_uq").on(t.workspaceId, t.domain)],
);

// ───────────────────────────── Integrations ─────────────────────────────

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: id(),
    workspaceId: wsRef(),
    provider: text("provider").notNull(), // instagram | meta_ads | higgsfield
    mode: text("mode").notNull(), // live | mock
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    username: text("username"),
    status: text("status").notNull(), // connected | token_expired | revoked | error | disconnected
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    tokenExpiresAt: ts("token_expires_at"),
    lastHealthCheckAt: ts("last_health_check_at"),
    healthError: text("health_error"),
    automationPaused: boolean("automation_paused").notNull().default(false),
    settings: jsonb("settings").$type<AccountSettings>().notNull().default({}),
    currency: text("currency"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ca_ws_provider_ext_uq").on(t.workspaceId, t.provider, t.externalId),
    index("ca_ext_idx").on(t.provider, t.externalId),
  ],
);

export interface AccountSettings {
  commentMonitoring?: boolean;
  publicReplySuggestions?: boolean;
  privateReplies?: boolean;
  dmAutoReplies?: boolean;
  /** Facebook Page ID used for ad creatives (Meta ad accounts only). */
  pageId?: string;
}

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: id(),
    workspaceId: wsRef(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("grants_account_idx").on(t.accountId)],
);

/** OAuth `state` values. Not tenant-RLS protected because the callback resolves them by hash. */
export const oauthStates = pgTable("oauth_states", {
  id: text("id").primaryKey(), // sha256(state)
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  redirectPath: text("redirect_path").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const providerCapabilities = pgTable(
  "provider_capabilities",
  {
    id: id(),
    workspaceId: wsRef(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    status: text("status").notNull(), // available | unavailable | unknown
    reason: text("reason"),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cap_account_cap_uq").on(t.accountId, t.capability)],
);

export const providerSyncStates = pgTable(
  "provider_sync_states",
  {
    id: id(),
    workspaceId: wsRef(),
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    cursor: text("cursor"),
    status: text("status").notNull().default("idle"),
    error: text("error"),
    lastSyncedAt: ts("last_synced_at"),
  },
  (t) => [uniqueIndex("sync_account_kind_uq").on(t.workspaceId, t.accountId, t.kind)],
);

// ───────────────────────────── Agents ─────────────────────────────

export const agentSettings = pgTable(
  "agents",
  {
    id: id(),
    workspaceId: wsRef(),
    role: text("role").notNull(),
    paused: boolean("paused").notNull().default(false),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 10, scale: 2 }),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_ws_role_uq").on(t.workspaceId, t.role)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    workspaceId: wsRef(),
    agentRole: text("agent_role").notNull(),
    state: text("state").notNull(),
    input: jsonb("input").notNull().default({}),
    output: jsonb("output"),
    error: text("error"),
    provider: text("provider"), // llm gateway name or "mock"
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    steps: integer("steps").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(4),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    parentRunId: uuid("parent_run_id"),
    createdBy: uuid("created_by").references(() => users.id),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("runs_ws_idx").on(t.workspaceId, t.createdAt), index("runs_role_idx").on(t.workspaceId, t.agentRole)],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    workspaceId: wsRef(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_messages_run_idx").on(t.runId)],
);

export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: id(),
    workspaceId: wsRef(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    tier: integer("tier").notNull(),
    allowed: boolean("allowed").notNull(),
    reason: text("reason"),
    input: jsonb("input"),
    output: jsonb("output"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_inv_run_idx").on(t.runId)],
);

// ───────────────────────────── Campaigns & content ─────────────────────────────

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    workspaceId: wsRef(),
    name: text("name").notNull(),
    objective: text("objective"),
    status: text("status").notNull().default("planning"),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    timezone: text("timezone"),
    plan: jsonb("plan"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("campaigns_ws_idx").on(t.workspaceId)],
);

export const promotionOffers = pgTable(
  "promotion_offers",
  {
    id: id(),
    workspaceId: wsRef(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    rawRequest: text("raw_request"),
    discountType: text("discount_type"), // percent | fixed_amount | bogo | free_shipping | other
    discountValue: numeric("discount_value", { precision: 12, scale: 2 }),
    currency: text("currency"),
    eligibleProductIds: jsonb("eligible_product_ids").$type<string[]>().notNull().default([]),
    eligibleDescription: text("eligible_description"),
    exclusions: text("exclusions"),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    timezone: text("timezone"),
    durationDays: integer("duration_days"),
    redemptionInstructions: text("redemption_instructions"),
    landingPageUrl: text("landing_page_url"),
    customerEligibility: text("customer_eligibility"),
    stockNote: text("stock_note"),
    terms: text("terms"),
    approvedClaims: jsonb("approved_claims").$type<string[]>().notNull().default([]),
    adBudgetMinor: bigint("ad_budget_minor", { mode: "number" }),
    audienceNote: text("audience_note"),
    ownerId: uuid("owner_id").references(() => users.id),
    status: text("status").notNull().default("needs_input"),
    missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([]),
    channelApprovals: jsonb("channel_approvals").$type<Record<string, string>>().notNull().default({}),
    commerceStatus: text("commerce_status").notNull().default("not_connected"),
    version: integer("version").notNull().default(1),
    endReconciledAt: ts("end_reconciled_at"),
    reconciliationReport: jsonb("reconciliation_report"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("promotions_ws_idx").on(t.workspaceId)],
);

export const contentItems = pgTable(
  "content_items",
  {
    id: id(),
    workspaceId: wsRef(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    promotionId: uuid("promotion_id").references(() => promotionOffers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    format: text("format").notNull(), // post | carousel | story | reel
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(1),
    connectedAccountId: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    productIds: jsonb("product_ids").$type<string[]>().notNull().default([]),
    scheduledAt: ts("scheduled_at"),
    timezone: text("timezone"),
    publishedMediaId: text("published_media_id"),
    permalink: text("permalink"),
    publishedAt: ts("published_at"),
    publishMode: text("publish_mode"), // live | mock
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("content_ws_idx").on(t.workspaceId, t.scheduledAt),
    index("content_media_idx").on(t.workspaceId, t.publishedMediaId),
  ],
);

export const contentVersions = pgTable(
  "content_versions",
  {
    id: id(),
    workspaceId: wsRef(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    caption: text("caption").notNull().default(""),
    cta: text("cta"),
    altText: text("alt_text"),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    language: text("language").notNull().default("en"),
    targetSegment: text("target_segment"),
    mediaAssetIds: jsonb("media_asset_ids").$type<string[]>().notNull().default([]),
    brief: jsonb("brief"),
    sourceFactIds: jsonb("source_fact_ids").$type<string[]>().notNull().default([]),
    brandCheck: jsonb("brand_check"),
    contentHash: text("content_hash").notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by").references(() => users.id),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("content_version_uq").on(t.contentItemId, t.version), index("cv_ws_idx").on(t.workspaceId)],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    workspaceId: wsRef(),
    kind: text("kind").notNull(), // image | video
    origin: text("origin").notNull(), // upload | provider_generated | mock_generated
    title: text("title"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    rights: jsonb("rights").$type<{ owner?: string; license?: string; consent?: boolean; notes?: string }>(),
    altText: text("alt_text"),
    status: text("status").notNull().default("ready"),
    scanStatus: text("scan_status").notNull().default("not_scanned"),
    generationJobId: uuid("generation_job_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("media_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const mediaGenerationJobs = pgTable(
  "media_generation_jobs",
  {
    id: id(),
    workspaceId: wsRef(),
    provider: text("provider").notNull(),
    mode: text("mode").notNull(), // live | mock
    model: text("model").notNull(),
    kind: text("kind").notNull(), // image | video
    prompt: text("prompt").notNull(),
    params: jsonb("params").notNull().default({}),
    status: text("status").notNull(), // queued | submitted | in_progress | completed | failed | nsfw | canceled | timed_out
    providerRequestId: text("provider_request_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 4 }),
    estimatedCredits: numeric("estimated_credits", { precision: 10, scale: 3 }),
    error: text("error"),
    resultAssetIds: jsonb("result_asset_ids").$type<string[]>().notNull().default([]),
    contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
    pollCount: integer("poll_count").notNull().default(0),
    timeoutAt: ts("timeout_at"),
    createdBy: uuid("created_by").references(() => users.id),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("mgj_ws_idx").on(t.workspaceId, t.createdAt), index("mgj_req_idx").on(t.providerRequestId)],
);

// ───────────────────────────── Approvals & automation ─────────────────────────────

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    workspaceId: wsRef(),
    actionType: text("action_type").notNull(),
    tier: integer("tier").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    subjectVersion: integer("subject_version"),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    summary: jsonb("summary").$type<ApprovalSummary>().notNull(),
    status: text("status").notNull().default("pending"),
    requiredApprovals: integer("required_approvals").notNull().default(1),
    requestedBy: uuid("requested_by").references(() => users.id),
    requestedByAgentRunId: uuid("requested_by_agent_run_id"),
    expiresAt: ts("expires_at"),
    decidedAt: ts("decided_at"),
    executedAt: ts("executed_at"),
    statusReason: text("status_reason"),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_ws_status_idx").on(t.workspaceId, t.status, t.createdAt),
    index("approvals_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId),
  ],
);

export interface ApprovalSummary {
  title: string;
  channel: string;
  destination?: string;
  mode?: "live" | "mock";
  schedule?: { at?: string | null; timezone?: string | null };
  audience?: string;
  recipient?: string;
  budget?: { amountMinor: number; currency: string; period: string; durationDays?: number | null };
  landingPage?: string | null;
  risks: string[];
  sideEffects: string[];
  preview?: { text?: string; mediaAssetIds?: string[]; url?: string | null };
}

export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: id(),
    workspaceId: wsRef(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(), // approve | reject | request_changes | revoke
    reason: text("reason"),
    payloadHash: text("payload_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("decisions_request_idx").on(t.requestId)],
);

export const automationRules = pgTable(
  "automation_rules",
  {
    id: id(),
    workspaceId: wsRef(),
    kind: text("kind").notNull(), // comment_to_dm | scheduled_draft | notify
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode").notNull().default("approve_every"), // approve_every | bounded_auto | human_only
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    config: jsonb("config").notNull(),
    version: integer("version").notNull().default(1),
    activeFrom: ts("active_from"),
    activeUntil: ts("active_until"),
    timezone: text("timezone"),
    ownerId: uuid("owner_id").references(() => users.id),
    lastTestedAt: ts("last_tested_at"),
    lastTestResult: jsonb("last_test_result"),
    enabledBy: uuid("enabled_by").references(() => users.id),
    enabledAt: ts("enabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rules_ws_idx").on(t.workspaceId, t.kind)],
);

export const automationRuleVersions = pgTable(
  "automation_rule_versions",
  {
    id: id(),
    workspaceId: wsRef(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("rule_version_uq").on(t.ruleId, t.version)],
);

/** Durable job queue (Postgres SKIP LOCKED). See docs/decisions/0002-postgres-job-queue.md */
export const jobs = pgTable(
  "scheduled_jobs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("queued"), // queued | running | succeeded | failed | dead | cancelled | blocked
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    result: jsonb("result"),
    idempotencyKey: text("idempotency_key").unique(),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    index("jobs_ws_idx").on(t.workspaceId, t.status),
  ],
);

/**
 * Every externally visible mutation (publish, reply, private reply, DM, ad changes).
 * `idempotency_key` guarantees at most one row per intended action; `unknown` status means the
 * provider outcome is uncertain and must be reconciled before any retry.
 */
export const externalActions = pgTable(
  "external_actions",
  {
    id: id(),
    workspaceId: wsRef(),
    actionType: text("action_type").notNull(),
    tier: integer("tier").notNull(),
    provider: text("provider").notNull(),
    mode: text("mode").notNull(), // live | mock
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
    automationRuleId: uuid("automation_rule_id").references(() => automationRules.id),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("pending"), // pending | executing | succeeded | failed | unknown | blocked
    providerRef: text("provider_ref"),
    resultSummary: jsonb("result_summary"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("ext_ws_idx").on(t.workspaceId, t.createdAt), index("ext_subject_idx").on(t.subjectType, t.subjectId)],
);

// ───────────────────────────── Inbox ─────────────────────────────

export const contactRecords = pgTable(
  "contact_records",
  {
    id: id(),
    workspaceId: wsRef(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    username: text("username"),
    optedOut: boolean("opted_out").notNull().default(false),
    suppressed: boolean("suppressed").notNull().default(false),
    isLead: boolean("is_lead").notNull().default(false),
    lastPrivateReplyAt: ts("last_private_reply_at"),
    lastInboundDmAt: ts("last_inbound_dm_at"),
    firstSeenAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_uq").on(t.workspaceId, t.provider, t.externalId)],
);

export const inboxConversations = pgTable(
  "inbox_conversations",
  {
    id: id(),
    workspaceId: wsRef(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // instagram_comment | instagram_dm
    externalThreadId: text("external_thread_id").notNull(),
    contactId: uuid("contact_id").references(() => contactRecords.id, { onDelete: "set null" }),
    mediaExternalId: text("media_external_id"),
    mediaProductType: text("media_product_type"),
    contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
    status: text("status").notNull().default("open"), // open | needs_human | awaiting_approval | handled | ignored | closed
    intent: text("intent"),
    intentConfidence: numeric("intent_confidence", { precision: 4, scale: 3 }),
    matchedProductId: uuid("matched_product_id").references(() => products.id, { onDelete: "set null" }),
    sourceFactIds: jsonb("source_fact_ids").$type<string[]>().notNull().default([]),
    isLead: boolean("is_lead").notNull().default(false),
    humanTakeover: boolean("human_takeover").notNull().default(false),
    assignedTo: uuid("assigned_to").references(() => users.id),
    escalationReasons: jsonb("escalation_reasons").$type<string[]>().notNull().default([]),
    eligibility: jsonb("eligibility"),
    lastInboundAt: ts("last_inbound_at"),
    lastMessageAt: ts("last_message_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conv_uq").on(t.workspaceId, t.channel, t.externalThreadId),
    index("conv_ws_idx").on(t.workspaceId, t.status, t.lastMessageAt),
  ],
);

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: id(),
    workspaceId: wsRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversations.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(), // inbound | outbound
    kind: text("kind").notNull(), // comment | public_reply | private_reply | dm
    externalId: text("external_id"),
    text: text("text").notNull(),
    authorExternalId: text("author_external_id"),
    authorUsername: text("author_username"),
    providerCreatedAt: ts("provider_created_at"),
    mode: text("mode"), // live | mock (outbound only)
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("msg_ext_uq").on(t.workspaceId, t.kind, t.externalId),
    index("msg_conv_idx").on(t.conversationId, t.createdAt),
  ],
);

export const replyDrafts = pgTable(
  "reply_drafts",
  {
    id: id(),
    workspaceId: wsRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversations.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => inboxMessages.id, { onDelete: "set null" }),
    actionType: text("action_type").notNull(), // public_comment_reply | private_comment_reply | dm_reply
    text: text("text").notNull(),
    url: text("url"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    sourceFactIds: jsonb("source_fact_ids").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"), // draft | pending_approval | approved | sending | sent | failed | blocked | discarded
    blockedReasons: jsonb("blocked_reasons").$type<string[]>().notNull().default([]),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
    externalActionId: uuid("external_action_id").references(() => externalActions.id),
    automationRuleId: uuid("automation_rule_id").references(() => automationRules.id, { onDelete: "set null" }),
    agentRunId: uuid("agent_run_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("drafts_conv_idx").on(t.conversationId)],
);

export const crmSyncEvents = pgTable(
  "crm_sync_events",
  {
    id: id(),
    workspaceId: wsRef(),
    contactId: uuid("contact_id").references(() => contactRecords.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [index("crm_ws_idx").on(t.workspaceId)],
);

// ───────────────────────────── Ads ─────────────────────────────

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: id(),
    workspaceId: wsRef(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    promotionId: uuid("promotion_id").references(() => promotionOffers.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    objective: text("objective").notNull(),
    specialAdCategories: jsonb("special_ad_categories").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    dailyBudgetMinor: bigint("daily_budget_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    timezone: text("timezone"),
    destinationUrl: text("destination_url"),
    conversionEvent: text("conversion_event"),
    pixelId: text("pixel_id"),
    audience: jsonb("audience").notNull().default({}),
    placements: jsonb("placements").$type<string[]>().notNull().default([]),
    externalCampaignId: text("external_campaign_id"),
    mode: text("mode"),
    providerStatus: text("provider_status"),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("adc_ws_idx").on(t.workspaceId)],
);

export const adSets = pgTable(
  "ad_sets",
  {
    id: id(),
    workspaceId: wsRef(),
    adCampaignId: uuid("ad_campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    optimizationGoal: text("optimization_goal").notNull(),
    billingEvent: text("billing_event").notNull().default("IMPRESSIONS"),
    targeting: jsonb("targeting").notNull().default({}),
    externalId: text("external_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ad_sets_campaign_idx").on(t.adCampaignId)],
);

export const adCreatives = pgTable(
  "ad_creatives",
  {
    id: id(),
    workspaceId: wsRef(),
    adCampaignId: uuid("ad_campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    headline: text("headline").notNull(),
    primaryText: text("primary_text").notNull(),
    callToAction: text("call_to_action").notNull().default("LEARN_MORE"),
    externalCreativeId: text("external_creative_id"),
    externalAdId: text("external_ad_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ad_creatives_campaign_idx").on(t.adCampaignId)],
);

export const adActionRequests = pgTable(
  "ad_action_requests",
  {
    id: id(),
    workspaceId: wsRef(),
    adCampaignId: uuid("ad_campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // launch | pause | resume | budget_change
    params: jsonb("params").notNull().default({}),
    status: text("status").notNull().default("pending_approval"),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
    externalActionId: uuid("external_action_id").references(() => externalActions.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("ad_actions_campaign_idx").on(t.adCampaignId)],
);

export const adMetricsSnapshots = pgTable(
  "ad_metrics_snapshots",
  {
    id: id(),
    workspaceId: wsRef(),
    adCampaignId: uuid("ad_campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    dateStart: text("date_start").notNull(),
    dateStop: text("date_stop").notNull(),
    impressions: bigint("impressions", { mode: "number" }),
    reach: bigint("reach", { mode: "number" }),
    clicks: bigint("clicks", { mode: "number" }),
    spendMinor: bigint("spend_minor", { mode: "number" }),
    conversions: bigint("conversions", { mode: "number" }),
    currency: text("currency"),
    attributionWindow: text("attribution_window"),
    source: text("source").notNull(), // meta_insights | mock
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [index("adm_ws_idx").on(t.workspaceId, t.adCampaignId)],
);

export const contentMetricsSnapshots = pgTable(
  "content_metrics_snapshots",
  {
    id: id(),
    workspaceId: wsRef(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    externalMediaId: text("external_media_id").notNull(),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
    windowLabel: text("window_label").notNull(),
    source: text("source").notNull(), // instagram_insights | mock
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [index("cm_ws_idx").on(t.workspaceId, t.contentItemId)],
);

// ───────────────────────────── Operations ─────────────────────────────

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(), // user | agent | system | webhook | worker
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    approvalRequestId: uuid("approval_request_id"),
    provider: text("provider"),
    result: text("result").notNull(), // success | failure | blocked | info
    metadata: jsonb("metadata").notNull().default({}),
    correlationId: text("correlation_id"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_ws_idx").on(t.workspaceId, t.createdAt),
    index("audit_target_idx").on(t.workspaceId, t.targetType, t.targetId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    workspaceId: wsRef(),
    kind: text("kind").notNull(), // llm | media_generation | storage
    provider: text("provider").notNull(),
    model: text("model"),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    estimated: boolean("estimated").notNull().default(true),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    workspaceId: wsRef(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notif_ws_idx").on(t.workspaceId, t.createdAt)],
);

/** Raw provider webhook deliveries. Not RLS-scoped: resolved to a workspace during processing. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    eventKey: text("event_key").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    field: text("field"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"), // received | processed | ignored | failed
    statusReason: text("status_reason"),
    deliveries: integer("deliveries").notNull().default(1),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [uniqueIndex("webhook_event_uq").on(t.provider, t.eventKey)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export const RLS_TABLES = [
  "workspace_memberships",
  "invitations",
  "company_profiles",
  "knowledge_sources",
  "knowledge_documents",
  "knowledge_chunks",
  "company_facts",
  "brand_rules",
  "products",
  "allowed_domains",
  "connected_accounts",
  "oauth_grants",
  "provider_capabilities",
  "provider_sync_states",
  "agents",
  "agent_runs",
  "agent_messages",
  "tool_invocations",
  "campaigns",
  "promotion_offers",
  "content_items",
  "content_versions",
  "media_assets",
  "media_generation_jobs",
  "approval_requests",
  "approval_decisions",
  "automation_rules",
  "automation_rule_versions",
  "external_actions",
  "contact_records",
  "inbox_conversations",
  "inbox_messages",
  "reply_drafts",
  "crm_sync_events",
  "ad_campaigns",
  "ad_sets",
  "ad_creatives",
  "ad_action_requests",
  "ad_metrics_snapshots",
  "content_metrics_snapshots",
  "usage_events",
  "notifications",
] as const;

