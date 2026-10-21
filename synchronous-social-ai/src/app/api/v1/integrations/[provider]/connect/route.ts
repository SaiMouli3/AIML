import { z } from "zod";
import { route } from "@/server/http/handler";
import { startOAuth } from "@/server/services/integrations";

/** Returns the official Meta authorization URL. The browser navigates there; tokens never touch the client. */
export const POST = route({ permission: "integrations.manage", rateLimit: 20 }, ({ ctx, params }) => startOAuth(ctx, z.enum(["instagram", "meta_ads"]).parse(params.provider), "/integrations"));
