import { z } from "zod";
import { route } from "@/server/http/handler";
import { changeMemberRole, removeMember } from "@/server/services/workspace";

export const PATCH = route(
  { permission: "members.manage", body: z.object({ role: z.string().max(40) }) },
  async ({ ctx, params, body }) => {
    await changeMemberRole(ctx, z.uuid().parse(params.id), body.role);
    return { ok: true };
  },
);
export const DELETE = route({ permission: "members.manage" }, async ({ ctx, params }) => {
  await removeMember(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
