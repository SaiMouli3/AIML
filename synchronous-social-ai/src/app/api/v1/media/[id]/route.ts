import { z } from "zod";
import { route } from "@/server/http/handler";
import { deleteMedia, rightsSchema, updateMediaRights } from "@/server/services/media";

export const PATCH = route(
  {
    permission: "content.write",
    body: z.object({ altText: z.string().max(1000).optional(), rights: rightsSchema.optional() }),
  },
  ({ ctx, params, body }) => updateMediaRights(ctx, z.uuid().parse(params.id), body),
);
export const DELETE = route({ permission: "content.write" }, async ({ ctx, params }) => {
  await deleteMedia(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
