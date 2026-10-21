import { sql } from "drizzle-orm";
import { db, type Tx } from "./client";

/**
 * Run `fn` inside a transaction scoped to one workspace. Row-level security policies restrict every
 * tenant table to `app.workspace_id`, so a query that forgets its workspace filter still cannot read
 * or write another tenant's rows. Services also filter explicitly (defense in depth).
 */
export async function withTenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

/**
 * System-level transaction (auth lookups, webhook routing, queue claiming). Bypasses RLS; callers must
 * apply explicit filters and must never pass user-controlled workspace ids without authorization.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
    return fn(tx);
  });
}
