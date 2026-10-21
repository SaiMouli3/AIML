import { z } from "zod";
import { route } from "@/server/http/handler";
import { addFact, factInputSchema, listFacts } from "@/server/services/company-brain";

export const GET = route(
  {
    permission: "brain.read",
    query: z.object({ status: z.string().max(20).optional(), category: z.string().max(40).optional() }),
  },
  ({ ctx, query }) => listFacts(ctx, query),
);
export const POST = route({ permission: "brain.write", body: factInputSchema }, ({ ctx, body }) =>
  addFact(ctx, body),
);
