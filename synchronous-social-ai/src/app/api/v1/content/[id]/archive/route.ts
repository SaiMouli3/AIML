import { z } from "zod";
import { route } from "@/server/http/handler";
import { archiveContent } from "@/server/services/content";

export const POST = route({ permission: "content.write" }, async ({ ctx, params }) => {
  await archiveContent(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
