import { z } from "zod";
import { route } from "@/server/http/handler";
import { duplicateContent } from "@/server/services/content";

/** Copy content to another channel as a new draft (each channel is approved separately). */
export const POST = route(
  { permission: "content.write", body: z.object({ accountId: z.uuid() }) },
  ({ ctx, params, body }) => duplicateContent(ctx, z.uuid().parse(params.id), body.accountId),
);
