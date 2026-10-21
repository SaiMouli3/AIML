import { z } from "zod";
import { route } from "@/server/http/handler";
import { OAUTH_PROVIDERS, startOAuth } from "@/server/services/integrations";

/** Returns the platform's official authorization URL. The browser navigates there; tokens never touch the client. */
export const POST = route({ permission: "integrations.manage", rateLimit: 20 }, ({ ctx, params }) =>
  startOAuth(ctx, z.enum(OAUTH_PROVIDERS).parse(params.provider), "/integrations"),
);
