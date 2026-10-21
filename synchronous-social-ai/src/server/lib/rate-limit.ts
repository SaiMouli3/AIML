import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { AppError } from "./errors";

/**
 * Fixed-window rate limiter persisted in Postgres so limits hold across web and worker instances.
 * Returns the remaining budget; throws RATE_LIMITED when `throwOnLimit` and the window is exhausted.
 */
export async function consumeRateLimit(
  ex: Executor,
  key: string,
  limit: number,
  windowSeconds: number,
  opts: { throwOnLimit?: boolean; cost?: number } = {},
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const cost = opts.cost ?? 1;
  const res = await ex.execute<{ count: number }>(sql`
    insert into rate_limit_buckets (key, window_start, count) values (${key}, ${windowStart.toISOString()}, ${cost})
    on conflict (key, window_start) do update set count = rate_limit_buckets.count + ${cost}
    returning count`);
  const count = Number(res.rows[0]?.count ?? cost);
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000);
  const allowed = count <= limit;
  if (!allowed && opts.throwOnLimit) {
    throw new AppError("RATE_LIMITED", "Too many requests. Try again later.", { resetAt: resetAt.toISOString() });
  }
  return { allowed, remaining: Math.max(0, limit - count), resetAt };
}

/** Read-only check that does not consume budget. */
export async function peekRateLimit(ex: Executor, key: string, limit: number, windowSeconds: number) {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await ex.execute<{ count: number }>(
    sql`select count from rate_limit_buckets where key = ${key} and window_start = ${windowStart.toISOString()}`,
  );
  const count = Number(res.rows[0]?.count ?? 0);
  return { allowed: count < limit, remaining: Math.max(0, limit - count) };
}
