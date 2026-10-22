import { route } from "@/server/http/handler";
import { aiSettingsInput, getAiSettings, updateAiSettings } from "@/server/services/ai-config";

/** Owner only. API key values are write-only: responses show only whether a key is saved and its last 4 characters. */
export const GET = route({ permission: "ai.configure" }, ({ ctx }) => getAiSettings(ctx));
export const PUT = route(
  { permission: "ai.configure", body: aiSettingsInput, rateLimit: 30 },
  ({ ctx, body }) => updateAiSettings(ctx, body),
);
