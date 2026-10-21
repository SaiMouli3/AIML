import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import "@/server/register";
import { withSystem, withTenant } from "@/server/db/tenant";
import * as s from "@/server/db/schema";
import { env } from "@/server/env";
import { safeEqual } from "@/server/lib/crypto";
import { newCorrelationId } from "@/server/lib/ids";
import { createLogger, logger } from "@/server/lib/logger";
import { handleHiggsfieldWebhook } from "@/server/services/media";

/**
 * Higgsfield terminal-status webhook. Authenticated by a secret token we place in the callback URL
 * (Higgsfield does not document request signing). Deduplicated by request_id + terminal status; the
 * status endpoint remains the source of truth (polling continues as a fallback).
 */
export async function POST(req: NextRequest) {
  const token = env().HIGGSFIELD_WEBHOOK_TOKEN;
  const sp = req.nextUrl.searchParams;
  if (!token || !safeEqual(sp.get("token") ?? "", token))
    return new NextResponse("Forbidden", { status: 403 });
  const jobId = sp.get("job") ?? "";
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }
  const job = await withSystem(
    async (tx) =>
      (
        await tx
          .select({ id: s.mediaGenerationJobs.id, workspaceId: s.mediaGenerationJobs.workspaceId })
          .from(s.mediaGenerationJobs)
          .where(eq(s.mediaGenerationJobs.id, jobId))
          .limit(1)
      )[0],
  );
  if (!job) return NextResponse.json({ ignored: true });
  const correlationId = newCorrelationId();
  try {
    const r = await withTenant(job.workspaceId, (tx) =>
      handleHiggsfieldWebhook(
        {
          workspaceId: job.workspaceId,
          userId: null,
          role: "admin",
          actorType: "webhook",
          actorId: "higgsfield",
          correlationId,
          tx,
          log: createLogger({ correlationId }),
        },
        jobId,
        body,
      ),
    );
    return NextResponse.json(r);
  } catch (e) {
    logger.warn("higgsfield_webhook_rejected", { correlationId, error: e });
    // 4xx tells Higgsfield not to retry malformed envelopes.
    return new NextResponse("Invalid envelope", { status: 422 });
  }
}
