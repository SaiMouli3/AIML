import { z } from "zod";
import { route } from "@/server/http/handler";
import { refreshCapabilities } from "@/server/services/integrations";

export const POST = route({ permission: "integrations.manage", rateLimit: 20 }, ({ ctx, params }) => refreshCapabilities(ctx, z.uuid().parse(params.id)));
