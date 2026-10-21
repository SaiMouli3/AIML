import { z } from "zod";
import { route } from "@/server/http/handler";
import { getApproval } from "@/server/services/approvals";

export const GET = route({ permission: "approvals.read" }, ({ ctx, params }) => getApproval(ctx, z.uuid().parse(params.id)));
