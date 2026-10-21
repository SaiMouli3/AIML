import { z } from "zod";
import { route } from "@/server/http/handler";
import { calendar } from "@/server/services/content";

export const GET = route(
  {
    permission: "content.read",
    query: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
  },
  ({ ctx, query }) => calendar(ctx, query.from, query.to),
);
