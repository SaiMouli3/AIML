import { and, desc, eq } from "drizzle-orm";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { tierOf, type ActionType } from "../policy/policy";
import { isProviderError, ProviderError } from "../providers/errors";
import { PermanentError, RetryableError } from "../queue/queue";
import type { JobContext } from "../queue/runtime";
import { RescheduleSignal } from "../queue/signals";
import { recordProviderFailure } from "./integrations";

export type ExternalActionRow = typeof s.externalActions.$inferSelect;

export interface ExecutionResult {
  providerRef: string;
  summary?: Record<string, unknown>;
}

export interface ExternalActionSpec {
  actionType: ActionType;
  provider: string;
  accountId: string | null;
  subjectType: string;
  subjectId: string;
  idempotencyKey: string;
  approvalRequestId?: string | null;
  automationRuleId?: string | null;
  /** Policy + approval + eligibility checks inside a committed transaction. Throw AppError to block. */
  authorize(ctx: Ctx): Promise<{ payloadHash: string; mode: "live" | "mock" }>;
  /** The provider mutation. Runs outside any DB transaction. */
  execute(ctx: Ctx): Promise<ExecutionResult>;
  /** Look up provider state to resolve an uncertain outcome. Return null if it cannot be determined. */
  reconcile?(ctx: Ctx): Promise<{ found: boolean; result?: ExecutionResult } | null>;
  onSuccess(ctx: Ctx, result: ExecutionResult, row: ExternalActionRow): Promise<void>;
  onFailure(ctx: Ctx, error: string, final: boolean, row: ExternalActionRow): Promise<void>;
}

/**
 * Execute an external mutation at most once.
 *  - `idempotency_key` is unique: a duplicate job, webhook or click finds the existing row.
 *  - A succeeded row is never re-executed.
 *  - An `unknown` row (ambiguous provider response) is reconciled first; if reconciliation is impossible
 *    it stays `unknown` for a human to resolve. It is never blindly retried.
 */
export async function runExternalAction(
  jc: JobContext,
  spec: ExternalActionSpec,
): Promise<{ status: string; row: ExternalActionRow }> {
  const row = await jc.tenant(async (ctx) => {
    await ctx.tx
      .insert(s.externalActions)
      .values({
        workspaceId: ctx.workspaceId,
        actionType: spec.actionType,
        tier: tierOf(spec.actionType),
        provider: spec.provider,
        mode: "live",
        accountId: spec.accountId,
        subjectType: spec.subjectType,
        subjectId: spec.subjectId,
        approvalRequestId: spec.approvalRequestId ?? null,
        automationRuleId: spec.automationRuleId ?? null,
        idempotencyKey: spec.idempotencyKey,
        payloadHash: "pending",
        status: "pending",
        correlationId: jc.correlationId,
      })
      .onConflictDoNothing({ target: s.externalActions.idempotencyKey });
    const r = await ctx.tx
      .select()
      .from(s.externalActions)
      .where(eq(s.externalActions.idempotencyKey, spec.idempotencyKey))
      .limit(1);
    return r[0]!;
  });

  if (row.status === "succeeded") return { status: "duplicate", row };
  if (row.status === "blocked" || (row.status === "failed" && row.completedAt))
    return { status: row.status, row };

  if (row.status === "unknown" || row.status === "executing") {
    const rec = spec.reconcile ? await jc.tenant((ctx) => spec.reconcile!(ctx)).catch(() => null) : null;
    if (rec?.found && rec.result) {
      await finishSuccess(jc, spec, row, rec.result, true);
      return { status: "reconciled", row };
    }
    if (!rec) {
      await jc.tenant(async (ctx) => {
        await ctx.tx
          .update(s.externalActions)
          .set({
            status: "unknown",
            error:
              "Outcome uncertain and cannot be reconciled automatically. A human must verify on the provider and resolve.",
            updatedAt: new Date(),
          })
          .where(eq(s.externalActions.id, row.id));
        await audit(ctx, {
          action: "external.needs_manual_reconciliation",
          targetType: spec.subjectType,
          targetId: spec.subjectId,
          provider: spec.provider,
          result: "blocked",
          metadata: { actionType: spec.actionType },
        });
      });
      return { status: "unknown", row };
    }
    // Reconciliation confirmed the action did not happen: safe to attempt again.
  }

  // Authorize and mark executing in one committed transaction.
  let authorized: { payloadHash: string; mode: "live" | "mock" };
  try {
    authorized = await jc.tenant(async (ctx) => {
      const a = await spec.authorize(ctx);
      await ctx.tx
        .update(s.externalActions)
        .set({
          status: "executing",
          payloadHash: a.payloadHash,
          mode: a.mode,
          attempts: row.attempts + 1,
          updatedAt: new Date(),
        })
        .where(eq(s.externalActions.id, row.id));
      await audit(ctx, {
        action: "external.attempt",
        targetType: spec.subjectType,
        targetId: spec.subjectId,
        provider: spec.provider,
        approvalRequestId: spec.approvalRequestId ?? null,
        metadata: {
          actionType: spec.actionType,
          mode: a.mode,
          attempt: row.attempts + 1,
          automationRuleId: spec.automationRuleId,
        },
      });
      return a;
    });
  } catch (e) {
    const msg = e instanceof AppError ? e.message : String(e);
    await jc.tenant(async (ctx) => {
      await ctx.tx
        .update(s.externalActions)
        .set({ status: "blocked", error: msg, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(s.externalActions.id, row.id));
      await audit(ctx, {
        action: "external.blocked",
        targetType: spec.subjectType,
        targetId: spec.subjectId,
        provider: spec.provider,
        result: "blocked",
        approvalRequestId: spec.approvalRequestId ?? null,
        metadata: { actionType: spec.actionType, reason: msg },
      });
      await spec.onFailure(ctx, msg, true, row);
    });
    return { status: "blocked", row };
  }

  let result: ExecutionResult;
  try {
    result = await jc.tenant((ctx) => spec.execute(ctx));
  } catch (e) {
    if (e instanceof RescheduleSignal) {
      // Provider is still processing (media container, video upload, TikTok/Threads publish). The job payload
      // now carries the provider ref, so the next attempt continues that same request instead of creating another.
      await jc.tenant((ctx) =>
        ctx.tx
          .update(s.externalActions)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(s.externalActions.id, row.id)),
      );
      throw e;
    }
    const err = isProviderError(e)
      ? e
      : new ProviderError("unknown_outcome", spec.provider, (e as Error).message ?? String(e));
    if (err.kind === "unknown_outcome") {
      await jc.tenant(async (ctx) => {
        await ctx.tx
          .update(s.externalActions)
          .set({ status: "unknown", error: err.message, updatedAt: new Date() })
          .where(eq(s.externalActions.id, row.id));
        await audit(ctx, {
          action: "external.outcome_unknown",
          targetType: spec.subjectType,
          targetId: spec.subjectId,
          provider: spec.provider,
          result: "failure",
          metadata: { actionType: spec.actionType, error: err.message },
        });
      });
      // Re-run this job later: it will reconcile instead of retrying.
      throw new RetryableError("Outcome unknown; reconciliation scheduled", 60_000);
    }
    const final = !err.retryable;
    await jc.tenant(async (ctx) => {
      await ctx.tx
        .update(s.externalActions)
        .set({
          status: "failed",
          error: `${err.kind}: ${err.message}`.slice(0, 1000),
          ...(final ? { completedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(s.externalActions.id, row.id));
      if (row.accountId) await recordProviderFailure(ctx, row.accountId, err);
      await audit(ctx, {
        action: "external.failed",
        targetType: spec.subjectType,
        targetId: spec.subjectId,
        provider: spec.provider,
        result: "failure",
        approvalRequestId: spec.approvalRequestId ?? null,
        metadata: { actionType: spec.actionType, kind: err.kind, error: err.message, final },
      });
      await spec.onFailure(ctx, err.publicMessage, final, row);
    });
    if (final) throw new PermanentError(err.publicMessage);
    throw new RetryableError(err.publicMessage, err.meta.retryAfterMs);
  }
  await finishSuccess(jc, spec, row, result, false, authorized.mode);
  return { status: "succeeded", row };
}

async function finishSuccess(
  jc: JobContext,
  spec: ExternalActionSpec,
  row: ExternalActionRow,
  result: ExecutionResult,
  reconciled: boolean,
  mode?: string,
) {
  await jc.tenant(async (ctx) => {
    const [updated] = await ctx.tx
      .update(s.externalActions)
      .set({
        status: "succeeded",
        providerRef: result.providerRef,
        resultSummary: (result.summary ?? {}) as object,
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(s.externalActions.id, row.id))
      .returning();
    await audit(ctx, {
      action: reconciled ? "external.reconciled_success" : "external.succeeded",
      targetType: spec.subjectType,
      targetId: spec.subjectId,
      provider: spec.provider,
      approvalRequestId: spec.approvalRequestId ?? null,
      metadata: {
        actionType: spec.actionType,
        providerRef: result.providerRef,
        mode: mode ?? updated!.mode,
        automationRuleId: spec.automationRuleId,
      },
    });
    await spec.onSuccess(ctx, result, updated!);
  });
}

export async function listExternalActions(
  ctx: Ctx,
  opts: { subjectId?: string; status?: string; limit?: number } = {},
) {
  const conds = [eq(s.externalActions.workspaceId, ctx.workspaceId)];
  if (opts.subjectId) conds.push(eq(s.externalActions.subjectId, opts.subjectId));
  if (opts.status) conds.push(eq(s.externalActions.status, opts.status));
  return ctx.tx
    .select()
    .from(s.externalActions)
    .where(and(...conds))
    .orderBy(desc(s.externalActions.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}
