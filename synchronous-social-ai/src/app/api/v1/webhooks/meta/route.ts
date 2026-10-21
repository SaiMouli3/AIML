import { NextResponse, type NextRequest } from "next/server";
import "@/server/register";
import { withSystem } from "@/server/db/tenant";
import { env } from "@/server/env";
import { safeEqual } from "@/server/lib/crypto";
import { verifyMetaSignature } from "@/server/lib/webhook-signature";
import { newCorrelationId } from "@/server/lib/ids";
import { logger } from "@/server/lib/logger";
import { consumeRateLimit } from "@/server/lib/rate-limit";
import { ingestWebhookEvents, normalizeMetaWebhook } from "@/server/services/inbox";
import { db } from "@/server/db/client";

/** Meta webhook verification handshake (hub.mode=subscribe, hub.verify_token, hub.challenge). */
export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = env().META_WEBHOOK_VERIFY_TOKEN;
  if (sp.get("hub.mode") === "subscribe" && token && safeEqual(sp.get("hub.verify_token") ?? "", token)) {
    return new NextResponse(sp.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/**
 * Event notifications. The raw body is HMAC-SHA256 verified with the app secret (X-Hub-Signature-256)
 * before parsing. Events are persisted and deduplicated, then processed by the durable queue; we
 * acknowledge quickly as Meta requires.
 */
export async function POST(req: NextRequest) {
  const correlationId = newCorrelationId();
  const raw = await req.text();
  if (raw.length > 1_000_000) return new NextResponse("Payload too large", { status: 413 });
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), env().META_APP_SECRET)) {
    logger.warn("meta_webhook_bad_signature", { correlationId });
    return new NextResponse("Invalid signature", { status: 401 });
  }
  await consumeRateLimit(db(), "webhook:meta", 5000, 60);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }
  const { events, ignored } = normalizeMetaWebhook(payload);
  const results = await withSystem((tx) => ingestWebhookEvents(tx, "instagram", events, correlationId));
  logger.info("meta_webhook_received", { correlationId, events: events.length, ignored, results });
  return NextResponse.json({ received: events.length, ignored });
}
