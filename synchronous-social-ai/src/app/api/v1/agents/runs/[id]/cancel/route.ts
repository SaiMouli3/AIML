import { z } from "zod";
import { cancelAgentRun } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

export const POST = route({ permission: "agents.run" }, async ({ ctx, params }) => {
  await cancelAgentRun(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
