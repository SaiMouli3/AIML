import { z } from "zod";
import { route } from "@/server/http/handler";
import { setContactFlags } from "@/server/services/inbox";

export const PATCH = route(
  {
    permission: "inbox.reply",
    body: z.object({ optedOut: z.boolean().optional(), suppressed: z.boolean().optional() }),
  },
  async ({ ctx, params, body }) => {
    await setContactFlags(ctx, z.uuid().parse(params.id), body);
    return { ok: true };
  },
);
