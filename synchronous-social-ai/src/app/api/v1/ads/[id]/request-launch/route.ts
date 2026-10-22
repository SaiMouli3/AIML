import { z } from "zod";
import { route } from "@/server/http/handler";
import { requestLaunch } from "@/server/services/ads";

export const POST = route({ permission: "approvals.request" }, ({ ctx, params }) =>
  requestLaunch(ctx, z.uuid().parse(params.id)),
);
