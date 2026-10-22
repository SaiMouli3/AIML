import { route } from "@/server/http/handler";
import { markAllRead } from "@/server/services/notifications";

export const POST = route({}, async ({ ctx }) => {
  await markAllRead(ctx);
  return { ok: true };
});
