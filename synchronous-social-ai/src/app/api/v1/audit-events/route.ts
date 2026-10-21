import { z } from "zod";
import { listAudit } from "@/server/audit/audit";
import { route } from "@/server/http/handler";

export const GET = route(
  {
    permission: "audit.read",
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.iso.datetime().optional(),
      action: z.string().max(80).optional(),
      targetType: z.string().max(40).optional(),
      targetId: z.string().max(80).optional(),
    }),
  },
  ({ ctx, query }) => listAudit(ctx, query),
);
