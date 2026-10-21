import { z } from "zod";
import { route } from "@/server/http/handler";
import { setAutomationPaused } from "@/server/services/workspace";

export const POST = route({ permission: "automations.manage", body: z.object({ paused: z.boolean() }) }, async ({ ctx, body }) => {
  await setAutomationPaused(ctx, body.paused);
  return { ok: true };
});
