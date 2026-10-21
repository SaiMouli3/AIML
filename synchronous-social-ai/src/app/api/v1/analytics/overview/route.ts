import { route } from "@/server/http/handler";
import { analyticsOverview } from "@/server/services/analytics";

export const GET = route({ permission: "analytics.read" }, ({ ctx }) => analyticsOverview(ctx));
