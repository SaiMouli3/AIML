import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { cancelJob, retryDeadJob } from "../queue/queue";

export async function listJobs(ctx: Ctx, status?: string) {
  requirePermission(ctx, "operations.manage");
  const conds = [eq(s.jobs.workspaceId, ctx.workspaceId)];
  if (status) conds.push(eq(s.jobs.status, status));
  const items = await ctx.tx.select().from(s.jobs).where(and(...conds)).orderBy(desc(s.jobs.updatedAt)).limit(100);
  const counts = await ctx.tx.select({ status: s.jobs.status, c: sql<number>`count(*)::int` }).from(s.jobs).where(eq(s.jobs.workspaceId, ctx.workspaceId)).groupBy(s.jobs.status);
  return { items: items.map((j) => ({ ...j, payload: undefined })), counts: Object.fromEntries(counts.map((c) => [c.status, c.c])) };
}

export async function retryJob(ctx: Ctx, id: string) {
  requirePermission(ctx, "operations.manage");
  requireUser(ctx);
  const job = (await ctx.tx.select().from(s.jobs).where(and(eq(s.jobs.id, id), eq(s.jobs.workspaceId, ctx.workspaceId))).limit(1))[0];
  if (!job) throw new AppError("NOT_FOUND", "Job not found");
  // External jobs with an uncertain outcome must be resolved first; never replay them blindly.
  const uncertain = await ctx.tx
    .select()
    .from(s.externalActions)
    .where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), eq(s.externalActions.status, "unknown"), eq(s.externalActions.correlationId, job.correlationId ?? "__none__")));
  if (uncertain.length) throw new AppError("CONFLICT", "This job has an external action with an unknown outcome. Resolve it first.");
  const r = await retryDeadJob(ctx.tx, id, ctx.workspaceId);
  if (!r) throw new AppError("CONFLICT", "Only dead-lettered or failed jobs can be retried");
  await audit(ctx, { action: "operations.job_retried", targetType: "job", targetId: id, metadata: { type: job.type } });
  return r;
}

export async function cancelQueuedJob(ctx: Ctx, id: string) {
  requirePermission(ctx, "operations.manage");
  requireUser(ctx);
  const r = await cancelJob(ctx.tx, id, ctx.workspaceId);
  if (!r) throw new AppError("CONFLICT", "Only queued jobs can be cancelled");
  await audit(ctx, { action: "operations.job_cancelled", targetType: "job", targetId: id });
  return r;
}

/**
 * Human resolution of an external action with an unknown outcome, after checking the provider manually.
 * "sent" records success without re-sending; "not_sent" allows a fresh, approved attempt.
 */
export async function resolveUnknownAction(ctx: Ctx, id: string, resolution: "sent" | "not_sent", note: string) {
  requirePermission(ctx, "operations.manage");
  requireUser(ctx);
  const a = (await ctx.tx.select().from(s.externalActions).where(and(eq(s.externalActions.id, id), eq(s.externalActions.workspaceId, ctx.workspaceId))).limit(1))[0];
  if (!a) throw new AppError("NOT_FOUND", "Action not found");
  if (a.status !== "unknown") throw new AppError("CONFLICT", "Only actions with an unknown outcome can be resolved");
  if (resolution === "sent") {
    await ctx.tx.update(s.externalActions).set({ status: "succeeded", error: `Manually confirmed: ${note}`.slice(0, 500), completedAt: new Date(), updatedAt: new Date() }).where(eq(s.externalActions.id, id));
    if (a.subjectType === "reply_draft") await ctx.tx.update(s.replyDrafts).set({ status: "sent" }).where(eq(s.replyDrafts.id, a.subjectId));
    if (a.subjectType === "content_item") await ctx.tx.update(s.contentItems).set({ status: "published", lastError: "Published status confirmed manually; media ID unknown" }).where(eq(s.contentItems.id, a.subjectId));
  } else {
    await ctx.tx.update(s.externalActions).set({ status: "failed", error: `Manually confirmed not sent: ${note}`.slice(0, 500), completedAt: new Date(), updatedAt: new Date() }).where(eq(s.externalActions.id, id));
    if (a.subjectType === "reply_draft") await ctx.tx.update(s.replyDrafts).set({ status: "failed" }).where(eq(s.replyDrafts.id, a.subjectId));
    if (a.subjectType === "content_item") await ctx.tx.update(s.contentItems).set({ status: "failed" }).where(eq(s.contentItems.id, a.subjectId));
  }
  await audit(ctx, { action: "operations.unknown_action_resolved", targetType: a.subjectType, targetId: a.subjectId, metadata: { actionId: id, resolution, note } });
}

export async function usageSummary(ctx: Ctx) {
  requirePermission(ctx, "usage.read");
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await ctx.tx
    .select({ kind: s.usageEvents.kind, provider: s.usageEvents.provider, model: s.usageEvents.model, qty: sql<string>`sum(${s.usageEvents.quantity})`, cost: sql<string>`sum(${s.usageEvents.costUsd})`, n: sql<number>`count(*)::int`, estimated: sql<boolean>`bool_or(${s.usageEvents.estimated})` })
    .from(s.usageEvents)
    .where(and(eq(s.usageEvents.workspaceId, ctx.workspaceId), gte(s.usageEvents.createdAt, start)))
    .groupBy(s.usageEvents.kind, s.usageEvents.provider, s.usageEvents.model);
  const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
  return {
    since: start.toISOString(),
    rows: rows.map((r) => ({ ...r, qty: Number(r.qty), cost: Number(r.cost) })),
    budgets: { llmMonthlyBudgetUsd: ws.settings.llmMonthlyBudgetUsd ?? null, mediaMonthlyBudgetUsd: ws.settings.mediaMonthlyBudgetUsd ?? null, adSpendCapMinor: ws.monthlyAdSpendCapMinor },
    note: "Costs are provider-reported where available, otherwise estimated from list prices. Estimates are not final charges.",
  };
}

export async function unknownActions(ctx: Ctx) {
  requirePermission(ctx, "operations.manage");
  return ctx.tx.select().from(s.externalActions).where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), inArray(s.externalActions.status, ["unknown"]))).orderBy(desc(s.externalActions.createdAt));
}
