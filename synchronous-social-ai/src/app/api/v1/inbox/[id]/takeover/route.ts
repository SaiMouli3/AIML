import { z } from "zod";
import { route } from "@/server/http/handler";
import { setHumanTakeover } from "@/server/services/inbox";

export const POST = route({ permission: "inbox.reply", body: z.object({ takeover: z.boolean() }) }, async ({ ctx, params, body }) => {
  await setHumanTakeover(ctx, z.uuid().parse(params.id), body.takeover);
  return { ok: true };
});
