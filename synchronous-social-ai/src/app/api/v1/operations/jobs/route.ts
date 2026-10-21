import { z } from "zod";
import { route } from "@/server/http/handler";
import { listJobs } from "@/server/services/operations";

export const GET = route(
  { permission: "operations.manage", query: z.object({ status: z.string().max(20).optional() }) },
  ({ ctx, query }) => listJobs(ctx, query.status),
);
