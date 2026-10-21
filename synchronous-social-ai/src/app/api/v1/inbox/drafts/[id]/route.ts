import { z } from "zod";
import { route } from "@/server/http/handler";
import { discardDraft, editDraft } from "@/server/services/inbox";

export const PATCH = route(
  { permission: "inbox.reply", body: z.object({ text: z.string().trim().min(1).max(1000) }) },
  ({ ctx, params, body }) => editDraft(ctx, z.uuid().parse(params.id), body.text),
);
export const DELETE = route({ permission: "inbox.reply" }, async ({ ctx, params }) => {
  await discardDraft(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
