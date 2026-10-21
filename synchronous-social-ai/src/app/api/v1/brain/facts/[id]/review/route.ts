import { z } from "zod";
import { route } from "@/server/http/handler";
import { reviewFact } from "@/server/services/company-brain";

export const POST = route({ permission: "brain.write", body: z.object({ decision: z.enum(["approve", "reject"]), value: z.string().trim().min(1).max(4000).optional() }) }, async ({ ctx, body, params }) => {
  await reviewFact(ctx, z.uuid().parse(params.id), body);
  return { ok: true };
});
