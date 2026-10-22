import { z } from "zod";
import { route } from "@/server/http/handler";
import { cancelPromotion } from "@/server/services/promotions";

export const POST = route({ permission: "campaigns.write" }, async ({ ctx, params }) => {
  await cancelPromotion(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
