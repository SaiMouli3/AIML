import { z } from "zod";
import { route } from "@/server/http/handler";
import { resolveUnknownAction } from "@/server/services/operations";

export const POST = route(
  {
    permission: "operations.manage",
    body: z.object({ resolution: z.enum(["sent", "not_sent"]), note: z.string().trim().min(3).max(500) }),
  },
  async ({ ctx, params, body }) => {
    await resolveUnknownAction(ctx, z.uuid().parse(params.id), body.resolution, body.note);
    return { ok: true };
  },
);
