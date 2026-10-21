import { z } from "zod";
import { route } from "@/server/http/handler";
import { createPromotionFromRequest, listPromotions } from "@/server/services/promotions";

export const GET = route({ permission: "campaigns.read" }, ({ ctx }) => listPromotions(ctx));
/** Parse a natural-language request ("Run 50% off for three days") into a structured draft + questions. */
export const POST = route({ permission: "campaigns.write", body: z.object({ request: z.string().trim().min(3).max(2000), name: z.string().max(160).optional() }) }, ({ ctx, body }) => createPromotionFromRequest(ctx, body.request, body.name));
