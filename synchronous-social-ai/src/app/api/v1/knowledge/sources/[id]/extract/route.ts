import { z } from "zod";
import { startAgentRun } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

/** Ask the company_knowledge agent to extract facts. Results land as *pending* facts for review. */
export const POST = route({ permission: "brain.write", rateLimit: 20 }, ({ ctx, params }) =>
  startAgentRun(ctx, "company_knowledge", { sourceId: z.uuid().parse(params.id) }, { subjectType: "knowledge_source", subjectId: z.uuid().parse(params.id) }),
);
