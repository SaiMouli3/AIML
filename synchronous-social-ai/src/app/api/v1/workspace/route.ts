import { z } from "zod";
import { route } from "@/server/http/handler";
import { deleteWorkspace, getWorkspace, settingsSchema, updateSettings } from "@/server/services/workspace";
import { storage } from "@/server/providers/storage/storage";

export const GET = route({}, ({ ctx }) => getWorkspace(ctx));
export const PATCH = route({ permission: "workspace.manage", body: settingsSchema }, ({ ctx, body }) =>
  updateSettings(ctx, body),
);
/** Offboarding: requires the owner to type the workspace slug. Deletes tenant rows and stored objects. */
export const DELETE = route(
  { permission: "workspace.manage", body: z.object({ confirmSlug: z.string().min(1).max(80) }) },
  async ({ ctx, body }) => {
    const { storagePrefix } = await deleteWorkspace(ctx, body.confirmSlug);
    await storage().deletePrefix(storagePrefix);
    return { ok: true };
  },
);
