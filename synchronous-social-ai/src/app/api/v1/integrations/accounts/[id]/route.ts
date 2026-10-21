import { z } from "zod";
import { route } from "@/server/http/handler";
import { accountSettingsSchema, disconnectAccount, updateAccountSettings } from "@/server/services/integrations";

export const PATCH = route({ permission: "integrations.read", body: accountSettingsSchema }, ({ ctx, params, body }) => updateAccountSettings(ctx, z.uuid().parse(params.id), body));
export const DELETE = route({ permission: "integrations.manage" }, async ({ ctx, params }) => {
  await disconnectAccount(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
