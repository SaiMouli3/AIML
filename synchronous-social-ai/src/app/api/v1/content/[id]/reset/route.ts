import { z } from "zod";
import { route } from "@/server/http/handler";
import { resetFailedContent } from "@/server/services/content";

export const POST = route({ permission: "content.write" }, async ({ ctx, params }) => {
  await resetFailedContent(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
