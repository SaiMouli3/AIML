import { z } from "zod";
import { route } from "@/server/http/handler";
import { connectMockAccount } from "@/server/services/integrations";

/** Development/test only: connects a clearly labelled MOCK account. Refused in staging/production. */
export const POST = route({ permission: "integrations.manage", body: z.object({ provider: z.enum(["instagram", "meta_ads"]) }) }, ({ ctx, body }) => connectMockAccount(ctx, body.provider));
