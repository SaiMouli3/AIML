import { z } from "zod";
import { route } from "@/server/http/handler";
import { retryJob } from "@/server/services/operations";

export const POST = route({ permission: "operations.manage" }, ({ ctx, params }) =>
  retryJob(ctx, z.uuid().parse(params.id)),
);
