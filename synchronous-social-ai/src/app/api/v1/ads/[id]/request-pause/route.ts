import { z } from "zod";
import { route } from "@/server/http/handler";
import { requestPause } from "@/server/services/ads";

export const POST = route({ permission: "approvals.request" }, ({ ctx, params }) =>
  requestPause(ctx, z.uuid().parse(params.id)),
);
