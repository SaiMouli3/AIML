import { z } from "zod";
import { route } from "@/server/http/handler";
import { createManualDraft, manualDraftSchema } from "@/server/services/inbox";

export const POST = route({ permission: "inbox.reply", body: manualDraftSchema }, ({ ctx, params, body }) =>
  createManualDraft(ctx, z.uuid().parse(params.id), body),
);
