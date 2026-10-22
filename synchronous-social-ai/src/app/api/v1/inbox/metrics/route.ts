import { z } from "zod";
import { route } from "@/server/http/handler";
import { inboxMetrics } from "@/server/services/inbox";

export const GET = route(
  {
    permission: "inbox.read",
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
  },
  ({ ctx, query }) => inboxMetrics(ctx, query.days),
);
