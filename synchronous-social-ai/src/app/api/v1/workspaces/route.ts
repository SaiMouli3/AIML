import { z } from "zod";
import { setActiveWorkspace } from "@/server/auth/session";
import { route } from "@/server/http/handler";
import { createAdditionalWorkspace } from "@/server/services/workspace";

export const POST = route(
  {
    auth: "user",
    body: z.object({ name: z.string().trim().min(2).max(120), timezone: z.string().max(64).default("UTC") }),
  },
  async ({ body, session }) => {
    const ws = await createAdditionalWorkspace(session!.user.id, body.name, body.timezone);
    await setActiveWorkspace(session!.sessionId, session!.user.id, ws.id);
    return { workspace: { id: ws.id, name: ws.name } };
  },
);
