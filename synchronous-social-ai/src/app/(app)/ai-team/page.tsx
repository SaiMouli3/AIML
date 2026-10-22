import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/primitives";
import * as s from "@/server/db/schema";
import { AGENT_ROLES, CONTRACTS } from "@/server/agents/contracts";
import { getRunDetail, listRuns } from "@/server/agents/orchestrator";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { integrationsConfigured } from "@/server/env";
import { AiTeamClient } from "./client";

export const metadata = { title: "AI Team" };
export const dynamic = "force-dynamic";

export default async function AiTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; role?: string }>;
}) {
  const sp = await searchParams;
  const { data, session } = await loadPage(async (ctx) => {
    const runs = await listRuns(ctx, { role: sp.role, limit: 100 });
    const settings = await ctx.tx
      .select()
      .from(s.agentSettings)
      .where(eq(s.agentSettings.workspaceId, ctx.workspaceId));
    const detail = sp.run ? await getRunDetail(ctx, sp.run).catch(() => null) : null;
    return { runs, settings, detail };
  });
  const agents = AGENT_ROLES.map((r) => {
    const c = CONTRACTS[r];
    return {
      role: r,
      title: c.title,
      purpose: c.purpose,
      nonGoals: c.nonGoals,
      allowedTools: c.allowedTools,
      disallowedActions: c.disallowedActions,
      model: c.model,
      maxSteps: c.maxSteps,
      budgetUsdPerRun: c.budgetUsdPerRun,
      timeoutMs: c.timeoutMs,
      escalation: c.escalation,
      sourceRequirements: c.sourceRequirements,
    };
  });
  return (
    <>
      <PageHeader
        title="AI Team"
        description="Eleven specialist roles with fixed contracts. Agents draft, analyse and propose; they cannot publish, send, spend, approve or change their own permissions."
      />
      <AiTeamClient
        data={serialize(data!) as never}
        agents={agents}
        canRun={can(session.role!, "agents.run")}
        canManage={can(session.role!, "agents.manage")}
        llmConfigured={integrationsConfigured.llm()}
      />
    </>
  );
}
