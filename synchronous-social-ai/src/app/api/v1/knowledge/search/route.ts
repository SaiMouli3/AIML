import { z } from "zod";
import { route } from "@/server/http/handler";
import { searchKnowledge } from "@/server/services/company-brain";

export const GET = route(
  { permission: "brain.read", query: z.object({ q: z.string().min(1).max(300) }) },
  ({ ctx, query }) => searchKnowledge(ctx, query.q, 10),
);
