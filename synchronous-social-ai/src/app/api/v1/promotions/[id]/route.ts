import { z } from "zod";
import { route } from "@/server/http/handler";
import { promotionPatchSchema, promotionReview, updatePromotion } from "@/server/services/promotions";

export const GET = route({ permission: "campaigns.read" }, ({ ctx, params }) =>
  promotionReview(ctx, z.uuid().parse(params.id)),
);
export const PATCH = route(
  { permission: "campaigns.write", body: promotionPatchSchema },
  ({ ctx, params, body }) => updatePromotion(ctx, z.uuid().parse(params.id), body),
);
