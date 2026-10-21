import { route } from "@/server/http/handler";
import { adDraftSchema, createAdDraft, listAds } from "@/server/services/ads";

export const GET = route({ permission: "campaigns.read" }, ({ ctx }) => listAds(ctx));
export const POST = route({ permission: "campaigns.write", body: adDraftSchema }, ({ ctx, body }) =>
  createAdDraft(ctx, body),
);
