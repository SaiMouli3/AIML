import { z } from "zod";
import { getRunDetail } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

export const GET = route({ permission: "content.read" }, ({ ctx, params }) =>
  getRunDetail(ctx, z.uuid().parse(params.id)),
);
