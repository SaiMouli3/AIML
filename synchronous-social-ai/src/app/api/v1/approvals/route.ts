import { z } from "zod";
import { route } from "@/server/http/handler";
import { listApprovals } from "@/server/services/approvals";

export const GET = route({ permission: "approvals.read", query: z.object({ status: z.string().max(30).optional() }) }, ({ ctx, query }) => listApprovals(ctx, query));
