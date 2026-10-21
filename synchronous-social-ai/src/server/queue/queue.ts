import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { withSystem } from "../db/tenant";
import { jobs } from "../db/schema";

export type JobRow = typeof jobs.$inferSelect;

export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  workspaceId: string | null;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
  correlationId?: string | null;
}

/**
 * Enqueue a durable job. With an idempotency key, enqueueing the same logical job twice returns the
 * existing job instead of creating a duplicate. Enqueue inside the same transaction as the state
 * change that requires it (transactional outbox) so they commit or roll back together.
 */
export async function enqueue(ex: Executor, input: EnqueueInput): Promise<JobRow> {
  const inserted = await ex
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload ?? {},
      workspaceId: input.workspaceId,
      runAt: input.runAt ?? new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
      maxAttempts: input.maxAttempts ?? 5,
      correlationId: input.correlationId ?? null,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await ex.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey!)).limit(1);
  return existing[0]!;
}

/** Exponential backoff with full jitter: base * 2^(attempt-1), capped, randomized in [50%, 100%]. */
export function backoffMs(attempt: number, baseMs = 2000, capMs = 10 * 60 * 1000, rand = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/**
 * Atomically claim runnable jobs with FOR UPDATE SKIP LOCKED. Enforces a per-tenant concurrency limit
 * and holds back external-mutation job types for workspaces whose kill switch is active.
 */
export async function claimJobs(opts: {
  workerId: string;
  limit: number;
  tenantConcurrency: number;
  externalTypes: string[];
}): Promise<JobRow[]> {
  if (opts.limit <= 0) return [];
  const external = opts.externalTypes.length ? opts.externalTypes : ["__none__"];
  return withSystem(async (tx) => {
    const res = await tx.execute(sql`
      with running as (
        select workspace_id, count(*)::int as c from scheduled_jobs where status = 'running' and workspace_id is not null group by workspace_id
      ),
      candidates as (
        select j.id from scheduled_jobs j
        left join workspaces w on w.id = j.workspace_id
        left join running r on r.workspace_id = j.workspace_id
        where j.status = 'queued' and j.run_at <= now()
          and coalesce(r.c, 0) < ${opts.tenantConcurrency}
          and (w.id is null or w.kill_switch = false or j.type not in (${sql.join(
            external.map((t) => sql`${t}`),
            sql`, `,
          )}))
        order by j.run_at
        limit ${opts.limit}
        for update of j skip locked
      )
      update scheduled_jobs set status = 'running', locked_at = now(), locked_by = ${opts.workerId},
        attempts = attempts + 1, updated_at = now()
      where id in (select id from candidates)
      returning id`);
    const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return [];
    return tx.select().from(jobs).where(inArray(jobs.id, ids));
  });
}

export async function completeJob(id: string, result: unknown) {
  await withSystem((tx) =>
    tx
      .update(jobs)
      .set({ status: "succeeded", result: (result ?? null) as object, lockedAt: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(jobs.id, id)),
  );
}

/** Retry transient failures with backoff; permanent failures and exhausted retries go to dead-letter. */
export async function failJob(job: JobRow, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
  const permanent = error instanceof PermanentError;
  const exhausted = job.attempts >= job.maxAttempts;
  const retryAfter = error instanceof RetryableError ? error.retryAfterMs : undefined;
  await withSystem((tx) =>
    tx
      .update(jobs)
      .set(
        permanent || exhausted
          ? { status: "dead", lastError: message, lockedAt: null, finishedAt: new Date(), updatedAt: new Date() }
          : {
              status: "queued",
              lastError: message,
              lockedAt: null,
              lockedBy: null,
              runAt: new Date(Date.now() + (retryAfter ?? backoffMs(job.attempts))),
              updatedAt: new Date(),
            },
      )
      .where(eq(jobs.id, job.id)),
  );
  return permanent || exhausted ? "dead" : "retry";
}

/** Reschedule without counting as a failure (e.g. polling an async provider). */
export async function rescheduleJob(id: string, delayMs: number, payload?: Record<string, unknown>) {
  await withSystem((tx) =>
    tx
      .update(jobs)
      .set({
        status: "queued",
        lockedAt: null,
        lockedBy: null,
        runAt: new Date(Date.now() + delayMs),
        attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
        ...(payload ? { payload } : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id)),
  );
}

/**
 * Recover jobs whose worker died. Jobs that may have performed an external mutation are NOT retried
 * blindly: they are marked failed so the reconciliation path decides what happened.
 */
export async function recoverStaleJobs(staleAfterMs: number, uncertainTypes: string[]) {
  const cutoff = new Date(Date.now() - staleAfterMs);
  return withSystem(async (tx) => {
    const stale = await tx.select().from(jobs).where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)));
    for (const j of stale) {
      if (uncertainTypes.includes(j.type)) {
        await tx
          .update(jobs)
          .set({ status: "dead", lastError: "Worker lost during external action; outcome requires reconciliation", lockedAt: null, updatedAt: new Date() })
          .where(eq(jobs.id, j.id));
      } else {
        await tx
          .update(jobs)
          .set({ status: "queued", lockedAt: null, lockedBy: null, runAt: new Date(), updatedAt: new Date() })
          .where(eq(jobs.id, j.id));
      }
    }
    return stale.length;
  });
}

/** Admin action: move a dead-lettered job back to the queue. */
export async function retryDeadJob(ex: Executor, id: string, workspaceId: string) {
  const res = await ex
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId), inArray(jobs.status, ["dead", "failed"])))
    .returning();
  return res[0] ?? null;
}

export async function cancelJob(ex: Executor, id: string, workspaceId: string) {
  const res = await ex
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId), eq(jobs.status, "queued")))
    .returning();
  return res[0] ?? null;
}
