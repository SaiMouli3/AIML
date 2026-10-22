import { z } from "zod";
import { route } from "@/server/http/handler";
import { removeBrandRule } from "@/server/services/company-brain";

export const DELETE = route({ permission: "brain.write" }, async ({ ctx, params }) => {
  await removeBrandRule(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
