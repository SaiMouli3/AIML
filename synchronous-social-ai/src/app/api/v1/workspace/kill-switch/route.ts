import { z } from "zod";
import { route } from "@/server/http/handler";
import { setKillSwitch } from "@/server/services/workspace";

export const POST = route({ permission: "workspace.kill_switch", body: z.object({ active: z.boolean(), reason: z.string().max(500).optional() }) }, async ({ ctx, body }) => {
  await setKillSwitch(ctx, body.active, body.reason);
  return { ok: true };
});
