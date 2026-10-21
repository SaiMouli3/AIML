import { z } from "zod";
import { AGENT_ROLES } from "@/server/agents/contracts";
import { setAgentPaused } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

export const POST = route({ permission: "agents.manage", body: z.object({ paused: z.boolean() }) }, async ({ ctx, params, body }) => {
  await setAgentPaused(ctx, z.enum(AGENT_ROLES).parse(params.role), body.paused);
  return { ok: true };
});
