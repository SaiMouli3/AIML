import { z } from "zod";
import { route } from "@/server/http/handler";
import { revokeInvite } from "@/server/services/workspace";

export const DELETE = route({ permission: "members.manage" }, async ({ ctx, params }) => {
  await revokeInvite(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
