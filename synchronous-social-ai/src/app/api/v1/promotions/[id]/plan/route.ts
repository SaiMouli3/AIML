import { z } from "zod";
import { route } from "@/server/http/handler";
import { planPromotion } from "@/server/services/promotions";

export const POST = route({ permission: "campaigns.write", body: z.object({ includeAds: z.boolean().default(false) }) }, ({ ctx, params, body }) => planPromotion(ctx, z.uuid().parse(params.id), body));
