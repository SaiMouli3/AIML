import { route } from "@/server/http/handler";
import { listIntegrations } from "@/server/services/integrations";
import { mediaProviderStatus } from "@/server/services/media";

export const GET = route({ permission: "integrations.read" }, async ({ ctx }) => ({
  ...(await listIntegrations(ctx)),
  media: mediaProviderStatus(),
}));
