import { z } from "zod";
import { route } from "@/server/http/handler";
import { requestPublishApproval } from "@/server/services/content";

export const POST = route({ permission: "approvals.request" }, ({ ctx, params }) =>
  requestPublishApproval(ctx, z.uuid().parse(params.id)),
);
