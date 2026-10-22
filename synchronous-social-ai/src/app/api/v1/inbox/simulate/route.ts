import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withSystem } from "@/server/db/tenant";
import { env } from "@/server/env";
import { route } from "@/server/http/handler";
import { AppError } from "@/server/lib/errors";
import { getAccount } from "@/server/services/integrations";
import { ingestWebhookEvents, normalizeMetaWebhook } from "@/server/services/inbox";

/**
 * Development/test only. Injects a webhook-shaped event for a MOCK account so the full pipeline
 * (dedupe → classify → resolve → draft → approvals) can be exercised without Meta.
 */
export const POST = route(
  {
    permission: "inbox.reply",
    body: z.object({
      accountId: z.uuid(),
      kind: z.enum(["comment", "dm"]),
      text: z.string().min(1).max(1000),
      mediaId: z.string().max(200).optional(),
      username: z.string().max(60).default("customer_demo"),
      commentId: z.string().max(100).optional(),
    }),
  },
  async ({ ctx, body, correlationId }) => {
    if (!env().mocksAllowed) throw new AppError("FORBIDDEN", "Simulation is disabled in this environment");
    const acct = await getAccount(ctx, body.accountId);
    if (acct.mode !== "mock")
      throw new AppError("FORBIDDEN", "Simulation is only available for mock accounts");
    if (acct.provider !== "instagram" && acct.provider !== "facebook")
      throw new AppError("VALIDATION_FAILED", "Only Instagram and Facebook accounts have an inbox");
    const from = { id: `sim_${body.username}`, username: body.username };
    const fb = acct.provider === "facebook";
    const entry =
      fb && body.kind === "comment"
        ? {
            id: acct.externalId,
            time: Math.floor(Date.now() / 1000),
            changes: [
              {
                field: "feed",
                value: {
                  item: "comment",
                  verb: "add",
                  comment_id: body.commentId ?? `sim_c_${randomUUID()}`,
                  post_id: body.mediaId ?? `${acct.externalId}_sim_post`,
                  message: body.text,
                  from: { id: from.id, name: body.username },
                  created_time: Math.floor(Date.now() / 1000),
                },
              },
            ],
          }
        : body.kind === "comment"
          ? {
              id: acct.externalId,
              time: Math.floor(Date.now() / 1000),
              field: "comments",
              value: {
                id: body.commentId ?? `sim_c_${randomUUID()}`,
                text: body.text,
                from,
                media: body.mediaId ? { id: body.mediaId, media_product_type: "REELS" } : undefined,
              },
            }
          : {
              id: acct.externalId,
              time: Date.now(),
              messaging: [
                {
                  sender: { id: from.id },
                  recipient: { id: acct.externalId },
                  timestamp: Date.now(),
                  message: { mid: `sim_m_${randomUUID()}`, text: body.text },
                },
              ],
            };
    const { events } = normalizeMetaWebhook({ object: fb ? "page" : "instagram", entry: [entry] });
    return {
      results: await withSystem((tx) => ingestWebhookEvents(tx, "mock", events, correlationId)),
    };
  },
);
