import { and, desc, eq, gte, sql } from "drizzle-orm";
import { seq } from "../lib/seq";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { redactString } from "../lib/redact";
import { agentMayUseTool, type Tier } from "../policy/policy";
import { isProviderError, ProviderError } from "../providers/errors";
import { liveLlmProvider, MockLlmProvider, type LlmProvider } from "../providers/llm/llm";
import { resolveAiConfig, type EffectiveAiConfig } from "../services/ai-config";
import { enqueue } from "../queue/queue";
import { registerJob, type JobContext } from "../queue/runtime";
import { groundingBundle, searchKnowledge } from "../services/company-brain";
import { CONTRACTS, isAgentRole, type AgentRole, type Grounding } from "./contracts";

// ───────────────────────────── Workflow state machine ─────────────────────────────

export const WORKFLOW_STATES = [
  "REQUESTED",
  "PLANNING",
  "DRAFTING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "QUEUED",
  "EXECUTING",
  "SUCCEEDED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
  "NEEDS_INPUT",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  REQUESTED: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["DRAFTING", "NEEDS_INPUT", "FAILED", "CANCELLED"],
  DRAFTING: ["VALIDATING", "FAILED", "CANCELLED"],
  VALIDATING: ["SUCCEEDED", "NEEDS_INPUT", "AWAITING_APPROVAL", "FAILED", "DRAFTING"],
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "NEEDS_INPUT"],
  APPROVED: ["QUEUED", "CANCELLED", "EXPIRED"],
  QUEUED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: ["AWAITING_APPROVAL"],
  NEEDS_INPUT: ["REQUESTED", "CANCELLED"],
  FAILED: ["REQUESTED"],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const TERMINAL_STATES: WorkflowState[] = [
  "SUCCEEDED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
  "NEEDS_INPUT",
];

export function canTransition(from: WorkflowState, to: WorkflowState) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: string, to: WorkflowState) {
  if (!canTransition(from as WorkflowState, to))
    throw new AppError("CONFLICT", `Invalid workflow transition ${from} → ${to}`);
}

// ───────────────────────────── Tool registry (Tier 0–2 only) ─────────────────────────────

export const TOOL_TIERS: Record<string, Tier> = {
  read_company_facts: 0,
  search_knowledge: 0,
  read_products: 0,
  read_promotion: 0,
  read_analytics: 0,
  read_source_text: 0,
  read_brand_rules: 0,
  read_media_rights: 0,
  read_media_jobs: 0,
  add_pending_fact: 1,
  create_draft_version: 1,
  create_reply_draft: 1,
  create_ad_draft: 1,
  create_media_job: 1,
  execute_approved_ad_action: 4,
};

async function recordTool(
  ctx: Ctx,
  runId: string,
  role: AgentRole,
  tool: string,
  input: unknown,
  output: unknown,
) {
  const contract = CONTRACTS[role];
  const tier = TOOL_TIERS[tool] ?? 4;
  const check = agentMayUseTool(contract.allowedTools, tool, tier);
  await ctx.tx.insert(s.toolInvocations).values({
    workspaceId: ctx.workspaceId,
    runId,
    tool,
    tier,
    allowed: check.allowed,
    reason: check.reason,
    input: input as object,
    output: check.allowed ? (output as object) : null,
  });
  if (!check.allowed) {
    await audit(ctx, {
      action: "agent.tool_denied",
      targetType: "agent_run",
      targetId: runId,
      result: "blocked",
      metadata: { tool, tier, reason: check.reason },
    });
    throw new AppError("POLICY_BLOCKED", check.reason ?? "Tool denied");
  }
}

// ───────────────────────────── Public API ─────────────────────────────

export type AgentRunRow = typeof s.agentRuns.$inferSelect;

/** Create a run (REQUESTED) and enqueue its execution. The HTTP request returns immediately. */
export async function startAgentRun(
  ctx: Ctx,
  role: AgentRole,
  input: unknown,
  opts: { subjectType?: string; subjectId?: string; parentRunId?: string } = {},
): Promise<AgentRunRow> {
  requirePermission(ctx, "agents.run");
  const contract = CONTRACTS[role];
  const parsed = contract.inputSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      "VALIDATION_FAILED",
      "Invalid agent input",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  await assertAgentAvailable(ctx, role);
  const [run] = await ctx.tx
    .insert(s.agentRuns)
    .values({
      workspaceId: ctx.workspaceId,
      agentRole: role,
      state: "REQUESTED",
      input: parsed.data as object,
      maxSteps: contract.maxSteps,
      subjectType: opts.subjectType ?? null,
      subjectId: opts.subjectId ?? null,
      parentRunId: opts.parentRunId ?? null,
      createdBy: ctx.userId,
      correlationId: ctx.correlationId,
    })
    .returning();
  await enqueue(ctx.tx, {
    type: "agent.run",
    workspaceId: ctx.workspaceId,
    payload: { runId: run!.id },
    idempotencyKey: `agent.run:${run!.id}`,
    correlationId: ctx.correlationId,
    maxAttempts: contract.maxRetries + 1,
  });
  await audit(ctx, {
    action: "agent.run_requested",
    targetType: "agent_run",
    targetId: run!.id,
    metadata: { role },
  });
  return run!;
}

async function assertAgentAvailable(ctx: Ctx, role: AgentRole) {
  const rows = await ctx.tx
    .select()
    .from(s.agentSettings)
    .where(and(eq(s.agentSettings.workspaceId, ctx.workspaceId), eq(s.agentSettings.role, role)))
    .limit(1);
  if (rows[0]?.paused) throw new AppError("POLICY_BLOCKED", `The ${CONTRACTS[role].title} agent is paused`);
}

export async function cancelAgentRun(ctx: Ctx, runId: string) {
  requirePermission(ctx, "agents.run");
  const run = await getRun(ctx, runId);
  if (TERMINAL_STATES.includes(run.state as WorkflowState))
    throw new AppError("CONFLICT", `Run is already ${run.state}`);
  await ctx.tx
    .update(s.agentRuns)
    .set({ state: "CANCELLED", finishedAt: new Date() })
    .where(eq(s.agentRuns.id, runId));
  await audit(ctx, { action: "agent.run_cancelled", targetType: "agent_run", targetId: runId });
}

export async function retryAgentRun(ctx: Ctx, runId: string) {
  const run = await getRun(ctx, runId);
  if (run.state !== "FAILED" && run.state !== "NEEDS_INPUT")
    throw new AppError("CONFLICT", "Only failed or needs-input runs can be retried");
  return startAgentRun(ctx, run.agentRole as AgentRole, run.input, {
    subjectType: run.subjectType ?? undefined,
    subjectId: run.subjectId ?? undefined,
    parentRunId: run.id,
  });
}

export async function getRun(ctx: Ctx, runId: string) {
  const rows = await ctx.tx
    .select()
    .from(s.agentRuns)
    .where(and(eq(s.agentRuns.id, runId), eq(s.agentRuns.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Agent run not found");
  return rows[0];
}

export async function getRunDetail(ctx: Ctx, runId: string) {
  const run = await getRun(ctx, runId);
  const [messages, tools] = await seq([
    () =>
      ctx.tx
        .select()
        .from(s.agentMessages)
        .where(eq(s.agentMessages.runId, runId))
        .orderBy(s.agentMessages.createdAt),
    () =>
      ctx.tx
        .select()
        .from(s.toolInvocations)
        .where(eq(s.toolInvocations.runId, runId))
        .orderBy(s.toolInvocations.createdAt),
  ]);
  return { run, messages, tools };
}

export async function listRuns(ctx: Ctx, opts: { role?: string; limit?: number } = {}) {
  const conds = [eq(s.agentRuns.workspaceId, ctx.workspaceId)];
  if (opts.role) conds.push(eq(s.agentRuns.agentRole, opts.role));
  return ctx.tx
    .select()
    .from(s.agentRuns)
    .where(and(...conds))
    .orderBy(desc(s.agentRuns.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export async function setAgentPaused(ctx: Ctx, role: AgentRole, paused: boolean) {
  requirePermission(ctx, "agents.manage");
  if (ctx.actorType !== "user") throw new AppError("FORBIDDEN", "Agents cannot change agent settings");
  await ctx.tx
    .insert(s.agentSettings)
    .values({ workspaceId: ctx.workspaceId, role, paused, updatedBy: ctx.userId })
    .onConflictDoUpdate({
      target: [s.agentSettings.workspaceId, s.agentSettings.role],
      set: { paused, updatedBy: ctx.userId, updatedAt: new Date() },
    });
  await audit(ctx, {
    action: paused ? "agent.paused" : "agent.resumed",
    targetType: "agent",
    targetId: role,
  });
}

export async function monthlyLlmSpend(ctx: Ctx) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await ctx.tx
    .select({ c: sql<string>`coalesce(sum(${s.usageEvents.costUsd}), 0)` })
    .from(s.usageEvents)
    .where(
      and(
        eq(s.usageEvents.workspaceId, ctx.workspaceId),
        eq(s.usageEvents.kind, "llm"),
        gte(s.usageEvents.createdAt, start),
      ),
    );
  return Number(r?.c ?? 0);
}

// ───────────────────────────── Execution ─────────────────────────────

let providerOverride: LlmProvider | null = null;
/** Tests can inject a provider (e.g. adversarial outputs). */
export function setLlmProviderForTests(p: LlmProvider | null) {
  providerOverride = p;
}

function providerFor(
  role: AgentRole,
  input: unknown,
  g: Grounding,
  ai: EffectiveAiConfig,
): LlmProvider | null {
  if (providerOverride) return providerOverride;
  const live = liveLlmProvider({ baseUrl: ai.llm.baseUrl, apiKey: ai.llm.apiKey, prices: ai.prices });
  if (live) return live;
  if (env().mocksAllowed) return new MockLlmProvider(() => CONTRACTS[role].mock(input as never, g));
  return null;
}

async function setState(
  jc: JobContext,
  runId: string,
  from: string,
  to: WorkflowState,
  extra: Partial<typeof s.agentRuns.$inferInsert> = {},
) {
  return jc.tenant(async (ctx) => {
    const cur = await getRun(ctx, runId);
    if (cur.state === "CANCELLED") return false;
    if (cur.state !== from) throw new AppError("CONFLICT", `Run state changed (${cur.state})`);
    assertTransition(from, to);
    await ctx.tx
      .update(s.agentRuns)
      .set({ state: to, ...extra, ...(TERMINAL_STATES.includes(to) ? { finishedAt: new Date() } : {}) })
      .where(eq(s.agentRuns.id, runId));
    return true;
  });
}

async function gatherGrounding(ctx: Ctx, run: AgentRunRow): Promise<Grounding> {
  const role = run.agentRole as AgentRole;
  const contract = CONTRACTS[role];
  const input = run.input as Record<string, unknown>;
  const bundle = await groundingBundle(ctx);
  await recordTool(
    ctx,
    run.id,
    role,
    contract.allowedTools.includes("read_company_facts") ? "read_company_facts" : contract.allowedTools[0]!,
    {},
    { facts: bundle.facts.length, products: bundle.products.length },
  );
  let snippets: Grounding["snippets"] = [];
  const q = contract.retrievalQuery?.(input as never);
  if (q && contract.allowedTools.includes("search_knowledge")) {
    snippets = (await searchKnowledge(ctx, q, 6)).map((r) => ({
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      text: r.text,
      injectionFlag: r.injectionFlag,
    }));
    await recordTool(ctx, run.id, role, "search_knowledge", { q }, { results: snippets.length });
  }
  if (role === "company_knowledge") {
    const src = await ctx.tx
      .select({ id: s.knowledgeSources.id, title: s.knowledgeSources.title })
      .from(s.knowledgeSources)
      .where(
        and(
          eq(s.knowledgeSources.id, String(input.sourceId)),
          eq(s.knowledgeSources.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    if (!src[0]) throw new AppError("NOT_FOUND", "Source not found");
    const chunks = await ctx.tx
      .select()
      .from(s.knowledgeChunks)
      .where(eq(s.knowledgeChunks.sourceId, src[0].id))
      .orderBy(s.knowledgeChunks.ordinal)
      .limit(12);
    snippets = chunks.map((c) => ({
      sourceId: src[0]!.id,
      sourceTitle: src[0]!.title,
      text: c.text,
      injectionFlag: c.injectionFlag,
    }));
    await recordTool(
      ctx,
      run.id,
      role,
      "read_source_text",
      { sourceId: src[0].id },
      { chunks: chunks.length },
    );
  }
  let promotion: Record<string, unknown> | null = null;
  if (typeof input.promotionId === "string" && contract.allowedTools.includes("read_promotion")) {
    const p = await ctx.tx
      .select()
      .from(s.promotionOffers)
      .where(
        and(eq(s.promotionOffers.id, input.promotionId), eq(s.promotionOffers.workspaceId, ctx.workspaceId)),
      )
      .limit(1);
    if (p[0]) {
      promotion = {
        name: p[0].name,
        discountType: p[0].discountType,
        discountValue: p[0].discountValue,
        startsAt: p[0].startsAt,
        endsAt: p[0].endsAt,
        timezone: p[0].timezone,
        terms: p[0].terms,
        exclusions: p[0].exclusions,
        landingPageUrl: p[0].landingPageUrl,
      };
      await recordTool(
        ctx,
        run.id,
        role,
        "read_promotion",
        { promotionId: input.promotionId },
        { found: true },
      );
    }
  }
  let metrics: Record<string, unknown> | null = null;
  if (role === "analytics_analyst") {
    const since = new Date(Date.now() - Number(input.windowDays ?? 28) * 86400_000);
    const [content, ads] = await seq([
      () =>
        ctx.tx
          .select()
          .from(s.contentMetricsSnapshots)
          .where(
            and(
              eq(s.contentMetricsSnapshots.workspaceId, ctx.workspaceId),
              gte(s.contentMetricsSnapshots.fetchedAt, since),
            ),
          )
          .limit(100),
      () =>
        ctx.tx
          .select()
          .from(s.adMetricsSnapshots)
          .where(
            and(
              eq(s.adMetricsSnapshots.workspaceId, ctx.workspaceId),
              gte(s.adMetricsSnapshots.fetchedAt, since),
            ),
          )
          .limit(100),
    ]);
    metrics = {
      contentSnapshots: content
        .filter((c) => c.source !== "mock")
        .map((c) => ({
          contentItemId: c.contentItemId,
          metrics: c.metrics,
          window: c.windowLabel,
          source: c.source,
        })),
      adSnapshots: ads
        .filter((a) => a.source !== "mock")
        .map((a) => ({
          adCampaignId: a.adCampaignId,
          impressions: a.impressions,
          clicks: a.clicks,
          spendMinor: a.spendMinor,
          currency: a.currency,
          window: `${a.dateStart}..${a.dateStop}`,
          source: a.source,
        })),
    };
    await recordTool(
      ctx,
      run.id,
      role,
      "read_analytics",
      { windowDays: input.windowDays },
      { content: content.length, ads: ads.length },
    );
  }
  return {
    company: bundle.profile,
    facts: bundle.facts.map((f) => ({ id: f.id, category: f.category, key: f.key, value: f.value })),
    products: bundle.products.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      priceMinor: p.priceMinor,
      currency: p.currency,
      stockStatus: p.stockStatus,
      variants: p.variants,
      deliveryPolicy: p.deliveryPolicy,
      keywords: p.keywords,
    })),
    rules: bundle.rules.map((r) => ({ kind: r.kind, text: r.text })),
    domains: bundle.domains,
    snippets,
    promotion,
    metrics,
  };
}

/**
 * Execute one run: REQUESTED → PLANNING (Tier-0 grounding) → DRAFTING (bounded LLM calls) →
 * VALIDATING (schema + contract post-validation) → SUCCEEDED | NEEDS_INPUT | FAILED.
 * Each phase commits separately; no transaction is held open across the model call.
 */
export async function executeAgentRun(
  jc: JobContext,
  runId: string,
): Promise<{ state: WorkflowState; output?: unknown }> {
  const run = await jc.tenant((ctx) => getRun(ctx, runId));
  if (TERMINAL_STATES.includes(run.state as WorkflowState))
    return { state: run.state as WorkflowState, output: run.output };
  if (!isAgentRole(run.agentRole)) throw new AppError("VALIDATION_FAILED", "Unknown agent role");
  const role = run.agentRole;
  const contract = CONTRACTS[role];

  if (run.state === "REQUESTED" && !(await setState(jc, runId, "REQUESTED", "PLANNING")))
    return { state: "CANCELLED" };

  let grounding: Grounding;
  let ai: EffectiveAiConfig;
  try {
    ai = await jc.tenant((ctx) => resolveAiConfig(ctx));
    grounding = await jc.tenant(async (ctx) => {
      const budget = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]?.settings.llmMonthlyBudgetUsd;
      if (
        budget !== undefined &&
        budget !== null &&
        contract.model !== "none" &&
        (await monthlyLlmSpend(ctx)) + contract.budgetUsdPerRun > budget
      ) {
        throw new AppError("BUDGET_EXCEEDED", `Monthly LLM budget of $${budget} would be exceeded`);
      }
      return gatherGrounding(ctx, run);
    });
  } catch (e) {
    await failRun(jc, runId, "PLANNING", e);
    return { state: "FAILED" };
  }

  if (!(await setState(jc, runId, "PLANNING", "DRAFTING"))) return { state: "CANCELLED" };

  const input = run.input as never;
  let output: unknown;
  let steps = 0;
  const usage = {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 0,
    model: "deterministic",
    provider: "none",
    estimated: false,
  };

  if (contract.model === "none") {
    output = contract.mock(input, grounding);
    steps = 1;
  } else {
    const provider = providerFor(role, input, grounding, ai);
    if (!provider) {
      await failRun(
        jc,
        runId,
        "DRAFTING",
        new AppError(
          "INTEGRATION_NOT_CONNECTED",
          "No LLM provider is configured. The workspace owner can add an API key in Settings → AI models & keys.",
        ),
      );
      return { state: "FAILED" };
    }
    const messages = contract.buildPrompt!(input, grounding);
    const model = contract.model === "fast" ? ai.models.fast : ai.models.default;
    const jsonSchema = z.toJSONSchema(contract.outputSchema, { target: "draft-7", io: "input" }) as Record<
      string,
      unknown
    >;
    let lastError: unknown = null;
    while (steps < contract.maxSteps && output === undefined) {
      steps++;
      try {
        const res = await provider.complete({
          model,
          messages,
          schemaName: role,
          jsonSchema,
          maxTokens: contract.maxTokens,
          timeoutMs: contract.timeoutMs,
        });
        usage.tokensIn += res.tokensIn;
        usage.tokensOut += res.tokensOut;
        usage.costUsd += res.costUsd;
        usage.latencyMs += res.latencyMs;
        usage.model = res.model;
        usage.provider = res.provider;
        usage.estimated = res.costEstimated;
        await jc.tenant((ctx) =>
          ctx.tx.insert(s.agentMessages).values({
            workspaceId: ctx.workspaceId,
            runId,
            role: "assistant",
            content: redactString(res.content.slice(0, 20000)),
          }),
        );
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(stripFences(res.content));
        } catch {
          throw new AppError("VALIDATION_FAILED", "Model output was not valid JSON");
        }
        const parsed = contract.outputSchema.safeParse(parsedJson);
        if (!parsed.success)
          throw new AppError(
            "VALIDATION_FAILED",
            `Model output failed schema validation: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")} ${i.message}`)
              .join("; ")}`,
          );
        output = parsed.data;
      } catch (e) {
        lastError = e;
        if (isProviderError(e) && !e.retryable) break;
        if (steps < contract.maxSteps) {
          messages.push({
            role: "user",
            content: `Your previous response was rejected: ${(e as Error).message.slice(0, 300)}. Return only valid JSON matching the schema.`,
          });
        }
      }
    }
    await recordUsage(jc, runId, usage);
    if (output === undefined) {
      await failRun(jc, runId, "DRAFTING", lastError ?? new Error("No output"), {
        steps,
        ...usageCols(usage),
      });
      return { state: "FAILED" };
    }
  }

  // Run may have been cancelled while the model was working: discard output.
  if (!(await setState(jc, runId, "DRAFTING", "VALIDATING", { steps, ...usageCols(usage) })))
    return { state: "CANCELLED" };

  const post = contract.postValidate
    ? contract.postValidate(output as never, input, grounding)
    : { output, escalate: false, reasons: [] as string[] };
  const confidence = (post.output as { confidence?: number }).confidence;
  const reasons = [...post.reasons];
  if (typeof confidence === "number" && confidence < contract.minConfidence)
    reasons.push(`Confidence ${confidence} below ${contract.minConfidence}`);
  const finalState: WorkflowState = post.escalate || reasons.length ? "NEEDS_INPUT" : "SUCCEEDED";
  await jc.tenant(async (ctx) => {
    await ctx.tx
      .update(s.agentRuns)
      .set({
        state: finalState,
        output: { result: post.output, escalationReasons: reasons, provider: usage.provider } as object,
        finishedAt: new Date(),
      })
      .where(eq(s.agentRuns.id, runId));
    await audit(ctx, {
      action: "agent.run_completed",
      targetType: "agent_run",
      targetId: runId,
      provider: usage.provider,
      metadata: { role, state: finalState, steps, model: usage.model, costUsd: usage.costUsd },
    });
    // Tier-1 side effect: extracted facts are stored as *pending* for human review (never auto-approved).
    if (role === "company_knowledge") {
      const facts = (
        post.output as {
          facts: Array<{ category: string; key: string; value: string; excerpt: string; confidence: number }>;
        }
      ).facts;
      await recordTool(ctx, runId, role, "add_pending_fact", { count: facts.length }, { ok: true });
      const { addFact } = await import("../services/company-brain");
      const writer = { ...ctx, role: "admin" as const };
      for (const f of facts) {
        await addFact(
          writer,
          {
            category: f.category as never,
            key: f.key,
            value: f.value,
            sourceId: String((run.input as { sourceId: string }).sourceId),
            sourceExcerpt: f.excerpt,
          },
          { origin: "agent", confidence: f.confidence, agentRunId: runId },
        );
      }
    }
  });
  return { state: finalState, output: post.output };
}

const stripFences = (s2: string) =>
  s2
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

function usageCols(u: {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
}) {
  return {
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    costUsd: u.costUsd.toFixed(6),
    latencyMs: u.latencyMs,
    model: u.model,
    provider: u.provider,
  };
}

async function recordUsage(
  jc: JobContext,
  runId: string,
  u: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    model: string;
    provider: string;
    estimated: boolean;
  },
) {
  if (u.provider === "none") return;
  await jc.tenant((ctx) =>
    ctx.tx.insert(s.usageEvents).values({
      workspaceId: ctx.workspaceId,
      kind: "llm",
      provider: u.provider,
      model: u.model,
      quantity: String(u.tokensIn + u.tokensOut),
      unit: "tokens",
      costUsd: u.costUsd.toFixed(6),
      estimated: u.estimated,
      agentRunId: runId,
    }),
  );
}

async function failRun(
  jc: JobContext,
  runId: string,
  from: string,
  e: unknown,
  extra: Partial<typeof s.agentRuns.$inferInsert> = {},
) {
  const message =
    e instanceof AppError ? e.message : e instanceof ProviderError ? e.publicMessage : "Agent run failed";
  await jc.tenant(async (ctx) => {
    const cur = await getRun(ctx, runId);
    if (cur.state === "CANCELLED") return;
    await ctx.tx
      .update(s.agentRuns)
      .set({ state: "FAILED", error: message, finishedAt: new Date(), ...extra })
      .where(eq(s.agentRuns.id, runId));
    await audit(ctx, {
      action: "agent.run_failed",
      targetType: "agent_run",
      targetId: runId,
      result: "failure",
      metadata: { from, error: e instanceof Error ? e.message : String(e) },
    });
  });
}

registerJob("agent.run", {
  async run(jc, payload) {
    return executeAgentRun(jc, String(payload.runId));
  },
});
