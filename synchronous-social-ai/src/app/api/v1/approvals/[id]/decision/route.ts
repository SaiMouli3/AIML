import { z } from "zod";
import { route } from "@/server/http/handler";
import { decide } from "@/server/services/approvals";

/** The client must echo the payload hash it displayed; a stale hash is rejected (approval bound to exact version). */
export const POST = route(
  { body: z.object({ decision: z.enum(["approve", "reject", "request_changes", "revoke"]), reason: z.string().max(1000).optional(), payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }), rateLimit: 60 },
  ({ ctx, params, body }) => decide(ctx, z.uuid().parse(params.id), body),
);
