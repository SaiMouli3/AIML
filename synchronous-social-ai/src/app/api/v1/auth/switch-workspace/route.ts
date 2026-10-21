import { z } from "zod";
import { setActiveWorkspace } from "@/server/auth/session";
import { route } from "@/server/http/handler";
import { AppError } from "@/server/lib/errors";

export const POST = route({ auth: "user", body: z.object({ workspaceId: z.uuid() }) }, async ({ body, session }) => {
  const ok = await setActiveWorkspace(session!.sessionId, session!.user.id, body.workspaceId);
  if (!ok) throw new AppError("FORBIDDEN", "You are not a member of that workspace");
  return { ok: true };
});
