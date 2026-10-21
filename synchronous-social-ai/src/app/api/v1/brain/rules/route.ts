import { route } from "@/server/http/handler";
import { addBrandRule, brandRuleSchema, listBrandRules } from "@/server/services/company-brain";

export const GET = route({ permission: "brain.read" }, ({ ctx }) => listBrandRules(ctx));
export const POST = route({ permission: "brain.write", body: brandRuleSchema }, ({ ctx, body }) => addBrandRule(ctx, body));
