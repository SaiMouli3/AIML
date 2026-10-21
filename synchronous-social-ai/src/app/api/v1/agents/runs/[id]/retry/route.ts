import { z } from "zod";
import { retryAgentRun } from "@/server/agents/orchestrator";
import { route } from "@/server/http/handler";

export const POST = route({ permission: "agents.run" }, ({ ctx, params }) => retryAgentRun(ctx, z.uuid().parse(params.id)));
