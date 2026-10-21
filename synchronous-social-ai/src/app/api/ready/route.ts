import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { env, integrationsConfigured } from "@/server/env";

export const dynamic = "force-dynamic";

/** Readiness: configuration is valid and the database answers. Provider status is informational only. */
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    env();
    checks.config = "ok";
  } catch (e) {
    ok = false;
    checks.config = (e as Error).message.slice(0, 200);
  }
  try {
    const r = await db().execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    checks.database = "ok";
    checks.migrations = String((r.rows[0] as { n: number }).n);
  } catch {
    ok = false;
    checks.database = "unavailable";
  }
  const providers = { llm: integrationsConfigured.llm(), meta: integrationsConfigured.meta(), higgsfield: integrationsConfigured.higgsfield() };
  return NextResponse.json({ status: ok ? "ready" : "not_ready", checks, providers }, { status: ok ? 200 : 503 });
}
