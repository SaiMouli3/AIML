import { route } from "@/server/http/handler";
import { usageSummary } from "@/server/services/operations";

export const GET = route({ permission: "usage.read" }, ({ ctx }) => usageSummary(ctx));
