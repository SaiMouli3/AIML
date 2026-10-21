import { z } from "zod";
import { route } from "@/server/http/handler";
import { getRule, ruleInputSchema, updateRule } from "@/server/services/automations";

export const GET = route({ permission: "automations.read" }, ({ ctx, params }) =>
  getRule(ctx, z.uuid().parse(params.id)),
);
/** Saving creates a new version and disables the rule until it is re-tested and re-enabled. */
export const PUT = route(
  { permission: "automations.manage", body: ruleInputSchema },
  ({ ctx, params, body }) => updateRule(ctx, z.uuid().parse(params.id), body),
);
