import { z } from "zod";
import { route } from "@/server/http/handler";
import { cancelQueuedJob } from "@/server/services/operations";

export const POST = route({ permission: "operations.manage" }, ({ ctx, params }) =>
  cancelQueuedJob(ctx, z.uuid().parse(params.id)),
);
