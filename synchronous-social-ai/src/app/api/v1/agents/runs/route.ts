import { z } from "zod";
import { AGENT_ROLES } from "@/server/agents/contracts";
import { listRuns, startAgentRun } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

export const GET = route(
  {
    permission: "content.read",
    query: z.object({
      role: z.enum(AGENT_ROLES).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  ({ ctx, query }) => listRuns(ctx, query),
);
export const POST = route(
  {
    permission: "agents.run",
    rateLimit: 30,
    body: z.object({
      role: z.enum(AGENT_ROLES),
      input: z.record(z.string(), z.unknown()),
      subjectType: z.string().max(40).optional(),
      subjectId: z.uuid().optional(),
    }),
  },
  ({ ctx, body }) =>
    startAgentRun(ctx, body.role, body.input, { subjectType: body.subjectType, subjectId: body.subjectId }),
);
