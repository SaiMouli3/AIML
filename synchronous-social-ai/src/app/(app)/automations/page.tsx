import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import * as s from "@/server/db/schema";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { listProducts } from "@/server/services/company-brain";
import { listRules } from "@/server/services/automations";
import { INTENTS } from "@/server/agents/contracts";
import { TEMPLATE_PLACEHOLDERS } from "@/server/services/automation-config";
import { AutomationsClient } from "./client";

export const metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const { data, session, allowed } = await loadPage(
    async (ctx) => {
      const ws = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]!;
      const accounts = (
        await ctx.tx
          .select()
          .from(s.connectedAccounts)
          .where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId))
      ).filter((a) => a.provider === "instagram" || a.provider === "facebook");
      return {
        rules: await listRules(ctx),
        products: await listProducts(ctx),
        accounts,
        automationPaused: ws.automationPaused,
        timezone: ws.timezone,
      };
    },
    { permission: "automations.read" },
  );
  if (!allowed) return <Forbidden what="Automations" />;
  return (
    <>
      <PageHeader
        title="Automations"
        description="Bounded rules with dry-run tests, versioning, limits and pause controls. Complaints, support, spam and unclear messages are never automated."
      />
      <AutomationsClient
        data={serialize(data!) as never}
        canManage={can(session.role!, "automations.manage")}
        intents={INTENTS.filter((i) => !["complaint", "support", "spam", "unknown"].includes(i))}
        placeholders={[...TEMPLATE_PLACEHOLDERS]}
      />
    </>
  );
}
