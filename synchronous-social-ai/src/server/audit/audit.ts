import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { Ctx } from "../context";
import type { Executor } from "../db/client";
import { auditEvents } from "../db/schema";
import { redact } from "../lib/redact";

export interface AuditInput {
  action: string;
  targetType?: string;
  targetId?: string | null;
  approvalRequestId?: string | null;
  provider?: string | null;
  result?: "success" | "failure" | "blocked" | "info";
  metadata?: Record<string, unknown>;
}

/** Append an immutable audit event. Metadata is redacted (secrets, emails, phone numbers, signed URLs). */
export async function audit(ctx: Ctx, input: AuditInput) {
  await writeAudit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    correlationId: ctx.correlationId,
    ip: ctx.ip ?? null,
    ...input,
  });
}

export async function writeAudit(
  ex: Executor,
  e: AuditInput & {
    workspaceId: string | null;
    actorType: string;
    actorId?: string | null;
    correlationId?: string | null;
    ip?: string | null;
  },
) {
  await ex.insert(auditEvents).values({
    workspaceId: e.workspaceId,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    approvalRequestId: e.approvalRequestId ?? null,
    provider: e.provider ?? null,
    result: e.result ?? "success",
    metadata: (redact(e.metadata ?? {}) as Record<string, unknown>) ?? {},
    correlationId: e.correlationId ?? null,
    ip: e.ip ?? null,
  });
}

export async function listAudit(
  ctx: Ctx,
  opts: { limit?: number; before?: string; action?: string; targetType?: string; targetId?: string },
) {
  const conds: SQL[] = [eq(auditEvents.workspaceId, ctx.workspaceId)];
  if (opts.action) conds.push(eq(auditEvents.action, opts.action));
  if (opts.targetType) conds.push(eq(auditEvents.targetType, opts.targetType));
  if (opts.targetId) conds.push(eq(auditEvents.targetId, opts.targetId));
  if (opts.before) conds.push(lt(auditEvents.createdAt, new Date(opts.before)));
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await ctx.tx
    .select()
    .from(auditEvents)
    .where(and(...conds))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page.at(-1)?.createdAt.toISOString() : null };
}
