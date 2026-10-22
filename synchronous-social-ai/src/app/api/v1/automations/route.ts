import { route } from "@/server/http/handler";
import { createRule, listRules, ruleInputSchema } from "@/server/services/automations";

export const GET = route({ permission: "automations.read" }, ({ ctx }) => listRules(ctx));
export const POST = route({ permission: "automations.manage", body: ruleInputSchema }, ({ ctx, body }) =>
  createRule(ctx, body),
);
