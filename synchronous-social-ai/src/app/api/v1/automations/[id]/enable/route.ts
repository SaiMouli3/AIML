import { z } from "zod";
import { route } from "@/server/http/handler";
import { setRuleEnabled } from "@/server/services/automations";

export const POST = route({ permission: "automations.manage" }, async ({ ctx, params }) => {
  await setRuleEnabled(ctx, z.uuid().parse(params.id), true);
  return { ok: true };
});
