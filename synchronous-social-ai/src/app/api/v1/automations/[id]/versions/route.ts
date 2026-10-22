import { z } from "zod";
import { route } from "@/server/http/handler";
import { ruleVersions } from "@/server/services/automations";

export const GET = route({ permission: "automations.read" }, ({ ctx, params }) =>
  ruleVersions(ctx, z.uuid().parse(params.id)),
);
