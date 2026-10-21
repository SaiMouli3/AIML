import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import * as s from "../db/schema";
import type { ApprovalSummary } from "../db/schema";
import { AppError } from "../lib/errors";
import { hashPayload } from "../lib/crypto";
import { requiredApprovalsFor, tierOf, type ActionType } from "../policy/policy";
import { notify } from "./notifications";

/**
 * Approval subjects build the *exact* payload that will be executed from current database state.
 * The same builder runs when approval is requested and immediately before execution; any material
 * difference changes the hash and the approval no longer applies.
 */
export interface ApprovalSubject {
  subjectType: string;
  build(
    ctx: Ctx,
    subjectId: string,
  ): Promise<{
    payload: Record<string, unknown>;
    summary: ApprovalSummary;
    version?: number | null;
    budgetMinor?: number | null;
    executeBy?: Date | null;
  }>;
  onApproved?(ctx: Ctx, approval: typeof s.approvalRequests.$inferSelect): Promise<void>;
  onClosed?(ctx: Ctx, approval: typeof s.approvalRequests.$inferSelect, status: string): Promise<void>;
}

const subjects = new Map<ActionType, ApprovalSubject>();
export function registerApprovalSubject(actionType: ActionType, subject: ApprovalSubject) {
  subjects.set(actionType, subject);
}
function subjectFor(actionType: string) {
  const sub = subjects.get(actionType as ActionType);
  if (!sub) throw new AppError("VALIDATION_FAILED", `No approval subject registered for ${actionType}`);
  return sub;
}

export type ApprovalRow = typeof s.approvalRequests.$inferSelect;
const OPEN_STATUSES = ["pending", "approved"];

export async function requestApproval(
  ctx: Ctx,
  input: { actionType: ActionType; subjectId: string; agentRunId?: string | null },
): Promise<ApprovalRow> {
  requirePermission(ctx, "approvals.request");
  const tier = tierOf(input.actionType);
  if (tier < 3) throw new AppError("VALIDATION_FAILED", "Tier 0–2 actions do not require approval");
  const sub = subjectFor(input.actionType);
  const built = await sub.build(ctx, input.subjectId);
  const payloadHash = hashPayload(built.payload);

  // Re-requesting an identical payload is idempotent.
  const open = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(
      and(
        eq(s.approvalRequests.workspaceId, ctx.workspaceId),
        eq(s.approvalRequests.subjectId, input.subjectId),
        eq(s.approvalRequests.actionType, input.actionType),
        inArray(s.approvalRequests.status, OPEN_STATUSES),
      ),
    );
  const same = open.find((a) => a.payloadHash === payloadHash);
  if (same) return same;
  for (const stale of open) await closeApproval(ctx, stale, "invalidated", "Superseded by a newer version");

  const ws = (
    await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
  )[0]!;
  const required = requiredApprovalsFor(input.actionType, {
    budgetMinor: built.budgetMinor,
    twoPersonThresholdMinor: ws.settings.twoPersonApprovalAdBudgetMinor ?? null,
  });
  const expiryHours = ws.settings.approvalExpiryHours ?? 72;
  const [row] = await ctx.tx
    .insert(s.approvalRequests)
    .values({
      workspaceId: ctx.workspaceId,
      actionType: input.actionType,
      tier,
      subjectType: sub.subjectType,
      subjectId: input.subjectId,
      subjectVersion: built.version ?? null,
      payload: built.payload,
      payloadHash,
      summary: built.summary,
      status: "pending",
      requiredApprovals: required,
      requestedBy: ctx.actorType === "user" ? ctx.userId : null,
      requestedByAgentRunId: input.agentRunId ?? null,
      // Scheduled actions stay approvable until shortly after their scheduled time.
      expiresAt: new Date(
        Math.max(Date.now() + expiryHours * 3600_000, (built.executeBy?.getTime() ?? 0) + 6 * 3600_000),
      ),
      correlationId: ctx.correlationId,
    })
    .returning();
  await audit(ctx, {
    action: "approval.requested",
    targetType: sub.subjectType,
    targetId: input.subjectId,
    approvalRequestId: row!.id,
    metadata: { actionType: input.actionType, tier, payloadHash, requiredApprovals: required },
  });
  await notify(ctx, {
    kind: "approval_requested",
    title: `Approval needed: ${built.summary.title}`,
    link: `/approvals?id=${row!.id}`,
  });
  return row!;
}

export async function getApproval(ctx: Ctx, id: string) {
  requirePermission(ctx, "approvals.read");
  const rows = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(eq(s.approvalRequests.id, id), eq(s.approvalRequests.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Approval request not found");
  const decisions = await ctx.tx
    .select({ d: s.approvalDecisions, name: s.users.name })
    .from(s.approvalDecisions)
    .innerJoin(s.users, eq(s.users.id, s.approvalDecisions.userId))
    .where(eq(s.approvalDecisions.requestId, id))
    .orderBy(s.approvalDecisions.createdAt);
  return { approval: rows[0], decisions };
}

export async function listApprovals(ctx: Ctx, opts: { status?: string; limit?: number } = {}) {
  requirePermission(ctx, "approvals.read");
  await expireApprovals(ctx);
  const conds = [eq(s.approvalRequests.workspaceId, ctx.workspaceId)];
  if (opts.status && opts.status !== "all") conds.push(eq(s.approvalRequests.status, opts.status));
  return ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(...conds))
    .orderBy(desc(s.approvalRequests.tier), desc(s.approvalRequests.createdAt))
    .limit(Math.min(opts.limit ?? 100, 200));
}

async function expireApprovals(ctx: Ctx) {
  const expired = await ctx.tx
    .update(s.approvalRequests)
    .set({ status: "expired", statusReason: "Approval window elapsed" })
    .where(
      and(
        eq(s.approvalRequests.workspaceId, ctx.workspaceId),
        inArray(s.approvalRequests.status, ["pending", "approved"]),
        sql`${s.approvalRequests.expiresAt} < now()`,
        sql`${s.approvalRequests.executedAt} is null`,
      ),
    )
    .returning();
  for (const a of expired) {
    await audit(ctx, {
      action: "approval.expired",
      targetType: a.subjectType,
      targetId: a.subjectId,
      approvalRequestId: a.id,
    });
    await subjects.get(a.actionType as ActionType)?.onClosed?.(ctx, a, "expired");
  }
}

export type Decision = "approve" | "reject" | "request_changes" | "revoke";

/**
 * Record a human decision. The approver must be a human with permission for the action's tier, must
 * have seen the current payload hash, and (for two-person approvals) must differ from earlier approvers.
 */
export async function decide(
  ctx: Ctx,
  id: string,
  input: { decision: Decision; reason?: string; payloadHash: string },
) {
  const userId = requireUser(ctx);
  const { approval } = await getApproval(ctx, id);
  requirePermission(ctx, approval.tier >= 4 ? "approvals.decide.tier4" : "approvals.decide.tier3");
  if (input.payloadHash !== approval.payloadHash) {
    throw new AppError(
      "APPROVAL_INVALIDATED",
      "You reviewed an outdated version. Reload to see the current payload.",
    );
  }

  if (input.decision === "revoke") {
    if (approval.status !== "approved" && approval.status !== "pending")
      throw new AppError("CONFLICT", `Cannot revoke an approval that is ${approval.status}`);
    if (approval.executedAt)
      throw new AppError("CONFLICT", "Already executed; use the provider action (e.g. pause/delete) instead");
  } else if (approval.status !== "pending") {
    throw new AppError("CONFLICT", `Approval is ${approval.status}`);
  }
  // Before approving, confirm the subject still matches what was requested.
  if (input.decision === "approve") {
    const current = await subjectFor(approval.actionType).build(ctx, approval.subjectId);
    if (hashPayload(current.payload) !== approval.payloadHash) {
      await closeApproval(ctx, approval, "invalidated", "Content changed after the approval was requested");
      throw new AppError(
        "APPROVAL_INVALIDATED",
        "The content changed after approval was requested. A new request is needed.",
      );
    }
  }

  if ((input.decision === "reject" || input.decision === "request_changes") && !input.reason?.trim()) {
    throw new AppError("VALIDATION_FAILED", "A reason is required");
  }

  if (input.decision === "approve") {
    const prior = await ctx.tx
      .select()
      .from(s.approvalDecisions)
      .where(
        and(
          eq(s.approvalDecisions.requestId, id),
          eq(s.approvalDecisions.decision, "approve"),
          eq(s.approvalDecisions.payloadHash, approval.payloadHash),
        ),
      );
    if (prior.some((p) => p.userId === userId))
      throw new AppError("CONFLICT", "You already approved this request");
    if (approval.requiredApprovals > 1 && approval.requestedBy === userId) {
      throw new AppError(
        "FORBIDDEN",
        "Two-person approval: the requester cannot approve their own high-risk request",
      );
    }
    await ctx.tx.insert(s.approvalDecisions).values({
      workspaceId: ctx.workspaceId,
      requestId: id,
      decision: "approve",
      reason: input.reason ?? null,
      payloadHash: approval.payloadHash,
      userId,
    });
    const count = prior.length + 1;
    await audit(ctx, {
      action: "approval.approved",
      targetType: approval.subjectType,
      targetId: approval.subjectId,
      approvalRequestId: id,
      metadata: { count, required: approval.requiredApprovals },
    });
    if (count >= approval.requiredApprovals) {
      const [updated] = await ctx.tx
        .update(s.approvalRequests)
        .set({ status: "approved", decidedAt: new Date() })
        .where(eq(s.approvalRequests.id, id))
        .returning();
      await subjectFor(approval.actionType).onApproved?.(ctx, updated!);
      return updated!;
    }
    return approval;
  }

  await ctx.tx.insert(s.approvalDecisions).values({
    workspaceId: ctx.workspaceId,
    requestId: id,
    decision: input.decision,
    reason: input.reason ?? null,
    payloadHash: approval.payloadHash,
    userId,
  });
  const status =
    input.decision === "reject"
      ? "rejected"
      : input.decision === "request_changes"
        ? "changes_requested"
        : "revoked";
  const updated = await closeApproval(ctx, approval, status, input.reason ?? null);
  return updated;
}

async function closeApproval(ctx: Ctx, approval: ApprovalRow, status: string, reason: string | null) {
  const [updated] = await ctx.tx
    .update(s.approvalRequests)
    .set({ status, statusReason: reason, decidedAt: new Date() })
    .where(eq(s.approvalRequests.id, approval.id))
    .returning();
  await audit(ctx, {
    action: `approval.${status}`,
    targetType: approval.subjectType,
    targetId: approval.subjectId,
    approvalRequestId: approval.id,
    metadata: { reason },
  });
  await subjects.get(approval.actionType as ActionType)?.onClosed?.(ctx, updated!, status);
  return updated!;
}

/** Called whenever a subject is materially edited: every open approval for it stops applying. */
export async function invalidateApprovalsForSubject(
  ctx: Ctx,
  subjectId: string,
  reason: string,
  actionTypes?: ActionType[],
) {
  const conds = [
    eq(s.approvalRequests.workspaceId, ctx.workspaceId),
    eq(s.approvalRequests.subjectId, subjectId),
    inArray(s.approvalRequests.status, OPEN_STATUSES),
    sql`${s.approvalRequests.executedAt} is null`,
  ];
  if (actionTypes?.length) conds.push(inArray(s.approvalRequests.actionType, actionTypes));
  const open = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(...conds));
  for (const a of open) await closeApproval(ctx, a, "invalidated", reason);
  return open.length;
}

/**
 * Executor-side verification. Rebuilds the payload from current state and returns the approval only if
 * it is approved, unexpired, unused and bound to exactly this payload.
 */
export async function loadApprovalForExecution(ctx: Ctx, approvalId: string) {
  const rows = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(eq(s.approvalRequests.id, approvalId), eq(s.approvalRequests.workspaceId, ctx.workspaceId)))
    .limit(1);
  const approval = rows[0];
  if (!approval) throw new AppError("NOT_FOUND", "Approval not found");
  const current = await subjectFor(approval.actionType).build(ctx, approval.subjectId);
  return { approval, currentHash: hashPayload(current.payload), payload: current.payload };
}

export async function markApprovalExecuted(ctx: Ctx, approvalId: string) {
  await ctx.tx
    .update(s.approvalRequests)
    .set({ status: "executed", executedAt: new Date() })
    .where(eq(s.approvalRequests.id, approvalId));
}

export async function pendingApprovalCount(ctx: Ctx) {
  const [r] = await ctx.tx
    .select({ c: sql<number>`count(*)::int` })
    .from(s.approvalRequests)
    .where(
      and(eq(s.approvalRequests.workspaceId, ctx.workspaceId), eq(s.approvalRequests.status, "pending")),
    );
  return r?.c ?? 0;
}
