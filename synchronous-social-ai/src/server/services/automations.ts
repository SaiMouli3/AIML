import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { classifyIntentRules } from "../agents/contracts";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { findUnsafeUrls } from "../lib/url-safety";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import {
  commentToDmConfigSchema,
  TEMPLATE_PLACEHOLDERS,
  templatePlaceholders,
  triggerMatches,
  withinSchedule,
} from "./automation-config";
import { listAllowedDomains, listProducts } from "./company-brain";
import { planReplies, resolveProduct } from "./inbox";
import { getAccount } from "./integrations";
import { isValidTimezone } from "./workspace";

export const scheduledDraftConfigSchema = z.object({
  brief: z.string().min(3).max(2000),
  format: z.enum(["post", "carousel", "story", "reel"]),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
});

export const ruleInputSchema = z.object({
  kind: z.enum(["comment_to_dm", "scheduled_draft"]),
  name: z.string().trim().min(1).max(120),
  approvalMode: z.enum(["approve_every", "bounded_auto", "human_only"]).default("approve_every"),
  accountId: z.uuid().nullable().optional(),
  campaignId: z.uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  activeFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  activeUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").nullable().optional(),
});

async function validateRule(ctx: Ctx, input: z.infer<typeof ruleInputSchema>) {
  const problems: string[] = [];
  let config: Record<string, unknown>;
  if (input.kind === "comment_to_dm") {
    const parsed = commentToDmConfigSchema.safeParse(input.config);
    if (!parsed.success)
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid rule configuration",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    const cfg = parsed.data;
    for (const t of [cfg.publicReplyTemplate, cfg.privateReplyTemplate]) {
      for (const ph of templatePlaceholders(t))
        if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(ph))
          problems.push(`Unknown placeholder {${ph}}`);
      for (const u of findUnsafeUrls(t, await listAllowedDomains(ctx)))
        problems.push(`Template link ${u.url}: ${u.reason}`);
    }
    if (/\{(price|product_url)\}/.test(cfg.publicReplyTemplate))
      problems.push("Public replies should not contain prices or links; put them in the private reply");
    if (cfg.allowedIntents.some((i) => ["complaint", "support", "spam", "unknown"].includes(i)))
      problems.push(
        "Complaints, support, spam and unknown intents cannot be automated; they always escalate to a human",
      );
    if (cfg.productIds.length) {
      const known = new Set((await listProducts(ctx)).map((p) => p.id));
      for (const id of cfg.productIds) if (!known.has(id)) problems.push(`Unknown product ${id}`);
    }
    if (input.approvalMode === "bounded_auto" && !input.accountId)
      problems.push("Auto-send rules must be scoped to one Instagram account");
    config = cfg;
  } else {
    const parsed = scheduledDraftConfigSchema.safeParse(input.config);
    if (!parsed.success)
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid rule configuration",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    if (input.approvalMode === "bounded_auto")
      problems.push("Scheduled draft rules only create drafts; publishing always needs approval");
    config = parsed.data;
  }
  if (input.accountId) {
    const acct = await getAccount(ctx, input.accountId);
    if (acct.provider !== "instagram" && acct.provider !== "facebook")
      problems.push("Rules must target an Instagram account or Facebook Page");
  }
  if (problems.length) throw new AppError("VALIDATION_FAILED", "Rule cannot be saved", problems);
  return config;
}

export async function createRule(ctx: Ctx, input: z.infer<typeof ruleInputSchema>) {
  requirePermission(ctx, "automations.manage");
  const userId = requireUser(ctx);
  const config = await validateRule(ctx, input);
  const ws = (
    await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
  )[0]!;
  const [rule] = await ctx.tx
    .insert(s.automationRules)
    .values({
      workspaceId: ctx.workspaceId,
      kind: input.kind,
      name: input.name,
      approvalMode: input.approvalMode,
      accountId: input.accountId ?? null,
      campaignId: input.campaignId ?? null,
      config,
      activeFrom: input.activeFrom ? new Date(input.activeFrom) : null,
      activeUntil: input.activeUntil ? new Date(input.activeUntil) : null,
      timezone: input.timezone ?? ws.timezone,
      ownerId: userId,
      enabled: false,
    })
    .returning();
  await ctx.tx.insert(s.automationRuleVersions).values({
    workspaceId: ctx.workspaceId,
    ruleId: rule!.id,
    version: 1,
    snapshot: rule!,
    createdBy: userId,
  });
  await audit(ctx, {
    action: "automation.rule_created",
    targetType: "automation_rule",
    targetId: rule!.id,
    metadata: { kind: input.kind, approvalMode: input.approvalMode },
  });
  return rule!;
}

export async function getRule(ctx: Ctx, id: string) {
  requirePermission(ctx, "automations.read");
  const r = await ctx.tx
    .select()
    .from(s.automationRules)
    .where(and(eq(s.automationRules.id, id), eq(s.automationRules.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Rule not found");
  return r[0];
}

/** Editing a rule creates a new version and disables it: the new version must be re-tested and re-enabled. */
export async function updateRule(ctx: Ctx, id: string, input: z.infer<typeof ruleInputSchema>) {
  requirePermission(ctx, "automations.manage");
  const userId = requireUser(ctx);
  const cur = await getRule(ctx, id);
  if (cur.kind !== input.kind) throw new AppError("VALIDATION_FAILED", "Rule kind cannot change");
  const config = await validateRule(ctx, input);
  const [rule] = await ctx.tx
    .update(s.automationRules)
    .set({
      name: input.name,
      approvalMode: input.approvalMode,
      accountId: input.accountId ?? null,
      campaignId: input.campaignId ?? null,
      config,
      activeFrom: input.activeFrom ? new Date(input.activeFrom) : null,
      activeUntil: input.activeUntil ? new Date(input.activeUntil) : null,
      timezone: input.timezone ?? cur.timezone,
      version: cur.version + 1,
      enabled: false,
      enabledBy: null,
      enabledAt: null,
      lastTestedAt: null,
      lastTestResult: null,
      updatedAt: new Date(),
    })
    .where(eq(s.automationRules.id, id))
    .returning();
  await ctx.tx.insert(s.automationRuleVersions).values({
    workspaceId: ctx.workspaceId,
    ruleId: id,
    version: rule!.version,
    snapshot: rule!,
    createdBy: userId,
  });
  await audit(ctx, {
    action: "automation.rule_updated",
    targetType: "automation_rule",
    targetId: id,
    metadata: { version: rule!.version, disabledPendingRetest: cur.enabled },
  });
  return rule!;
}

export const testInputSchema = z.object({
  samples: z.array(z.string().max(500)).min(1).max(20),
  linkedProductIds: z.array(z.uuid()).max(10).default([]),
});

/** Dry run: shows exactly what the rule would do for sample comments. Sends nothing. */
export async function testRule(ctx: Ctx, id: string, input: z.infer<typeof testInputSchema>) {
  requirePermission(ctx, "automations.manage");
  const rule = await getRule(ctx, id);
  if (rule.kind !== "comment_to_dm") {
    const cfg = scheduledDraftConfigSchema.parse(rule.config);
    const result = {
      kind: rule.kind,
      wouldCreate: `A ${cfg.format} draft every ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][cfg.weekday]} at ${cfg.hour}:00 (${rule.timezone}). Publishing still requires approval.`,
    };
    await ctx.tx
      .update(s.automationRules)
      .set({ lastTestedAt: new Date(), lastTestResult: result })
      .where(eq(s.automationRules.id, id));
    return result;
  }
  const cfg = commentToDmConfigSchema.parse(rule.config);
  const catalog = await listProducts(ctx);
  const domains = await listAllowedDomains(ctx);
  const results = input.samples.map((text) => {
    const c = classifyIntentRules(text);
    const res = resolveProduct(
      text,
      input.linkedProductIds.length ? input.linkedProductIds : cfg.productIds,
      catalog,
    );
    const matches =
      cfg.allowedIntents.includes(c.intent) &&
      triggerMatches(cfg, text) &&
      (!cfg.productIds.length || (res.product && cfg.productIds.includes(res.product.id)));
    const plan = planReplies({
      intent: c.intent,
      confidence: c.confidence,
      username: "customer",
      resolution: res,
      promotion: null,
      rule: cfg,
      minConfidence: cfg.minConfidence,
      injectionFlag: false,
      allowedDomains: domains,
    });
    const decision = !matches
      ? "no_match"
      : plan.escalate
        ? "escalate"
        : rule.approvalMode === "bounded_auto"
          ? "auto_send"
          : rule.approvalMode === "human_only"
            ? "draft_only"
            : "approval_required";
    return {
      text,
      intent: c.intent,
      confidence: c.confidence,
      product: res.product?.name ?? null,
      productReason: res.reason,
      decision,
      publicReply: plan.publicReply,
      privateReply: plan.privateReply,
      reasons: plan.escalationReasons,
    };
  });
  const result = {
    kind: rule.kind,
    version: rule.version,
    withinScheduleNow: withinSchedule(cfg, rule.timezone ?? "UTC"),
    results,
    sendsNothing: true,
  };
  await ctx.tx
    .update(s.automationRules)
    .set({ lastTestedAt: new Date(), lastTestResult: result })
    .where(eq(s.automationRules.id, id));
  await audit(ctx, {
    action: "automation.rule_tested",
    targetType: "automation_rule",
    targetId: id,
    metadata: { version: rule.version, samples: input.samples.length },
  });
  return result;
}

/**
 * Enabling is a human permission grant. Agents and workers can never call this (requireUser), the
 * current version must have been dry-run tested, and bounded rules must be account-scoped.
 */
export async function setRuleEnabled(ctx: Ctx, id: string, enabled: boolean) {
  requirePermission(ctx, "automations.manage");
  const userId = requireUser(ctx);
  const rule = await getRule(ctx, id);
  if (enabled) {
    if (!rule.lastTestedAt)
      throw new AppError("VALIDATION_FAILED", "Run a dry-run test of this version before enabling it");
    if (rule.approvalMode === "bounded_auto" && !rule.accountId)
      throw new AppError("VALIDATION_FAILED", "Auto-send rules must be scoped to one account");
  }
  await ctx.tx
    .update(s.automationRules)
    .set({
      enabled,
      enabledBy: enabled ? userId : null,
      enabledAt: enabled ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(s.automationRules.id, id));
  await audit(ctx, {
    action: enabled ? "automation.rule_enabled" : "automation.rule_disabled",
    targetType: "automation_rule",
    targetId: id,
    metadata: { version: rule.version, approvalMode: rule.approvalMode, accountId: rule.accountId },
  });
}

export async function listRules(ctx: Ctx) {
  requirePermission(ctx, "automations.read");
  return ctx.tx
    .select()
    .from(s.automationRules)
    .where(eq(s.automationRules.workspaceId, ctx.workspaceId))
    .orderBy(desc(s.automationRules.updatedAt));
}

export async function ruleVersions(ctx: Ctx, id: string) {
  await getRule(ctx, id);
  return ctx.tx
    .select()
    .from(s.automationRuleVersions)
    .where(eq(s.automationRuleVersions.ruleId, id))
    .orderBy(desc(s.automationRuleVersions.version));
}

/** Scheduler tick: create drafts for scheduled_draft rules (Tier 1 only; nothing is published). */
registerJob("automation.scheduled_drafts", {
  async run(jc) {
    const rules = await jc.system((tx) =>
      tx
        .select()
        .from(s.automationRules)
        .where(and(eq(s.automationRules.kind, "scheduled_draft"), eq(s.automationRules.enabled, true))),
    );
    let queued = 0;
    for (const r of rules) {
      const cfg = scheduledDraftConfigSchema.safeParse(r.config);
      if (!cfg.success) continue;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: r.timezone ?? "UTC",
        weekday: "short",
        hour: "numeric",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
        parts.find((p) => p.type === "weekday")!.value,
      );
      const hour = Number(parts.find((p) => p.type === "hour")!.value);
      if (wd !== cfg.data.weekday || hour !== cfg.data.hour) continue;
      const day = `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
      await jc.system((tx) =>
        enqueue(tx, {
          type: "automation.run_scheduled_draft",
          workspaceId: r.workspaceId,
          payload: { ruleId: r.id, version: r.version },
          idempotencyKey: `sched_draft:${r.id}:${r.version}:${day}`,
        }),
      );
      queued++;
    }
    return { queued };
  },
});

registerJob("automation.run_scheduled_draft", {
  async run(jc, payload) {
    return jc.tenant(async (ctx) => {
      const rule = (
        await ctx.tx
          .select()
          .from(s.automationRules)
          .where(eq(s.automationRules.id, String(payload.ruleId)))
          .limit(1)
      )[0];
      if (!rule?.enabled || rule.version !== Number(payload.version)) return { skipped: true };
      const ws = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]!;
      if (ws.automationPaused) return { skipped: "automation paused" };
      const cfg = scheduledDraftConfigSchema.parse(rule.config);
      const { startAgentRun } = await import("../agents/orchestrator");
      const run = await startAgentRun(
        { ...ctx, role: "creator" },
        "content_copywriter",
        { brief: cfg.brief, format: cfg.format, variants: 2, language: "en", productIds: [] },
        { subjectType: "automation_rule", subjectId: rule.id },
      );
      await audit(ctx, {
        action: "automation.scheduled_draft_started",
        targetType: "automation_rule",
        targetId: rule.id,
        metadata: { runId: run.id },
      });
      return { runId: run.id };
    });
  },
});
