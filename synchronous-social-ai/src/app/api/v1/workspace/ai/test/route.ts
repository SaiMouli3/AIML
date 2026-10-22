import { z } from "zod";
import { route } from "@/server/http/handler";
import { testGateway } from "@/server/services/ai-config";

/** Owner only. Lists the gateway's models and prices with the saved or a just-typed URL/key; stores nothing. */
export const POST = route(
  {
    permission: "ai.configure",
    rateLimit: 10,
    body: z.object({
      llmBaseUrl: z.string().trim().max(300).optional(),
      apiKey: z.string().trim().min(8).max(500).optional(),
    }),
  },
  ({ ctx, body }) => testGateway(ctx, body),
);
