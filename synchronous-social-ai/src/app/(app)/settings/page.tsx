import { PageHeader } from "@/components/ui/primitives";
import { listAudit } from "@/server/audit/audit";
import { env } from "@/server/env";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { listJobs, unknownActions, usageSummary } from "@/server/services/operations";
import { getWorkspace } from "@/server/services/workspace";
import { getAiSettings } from "@/server/services/ai-config";
import { SettingsClient } from "./client";

export const metadata = { title: "Settings & Usage" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { data, session } = await loadPage(async (ctx) => ({
    workspace: await getWorkspace(ctx),
    usage: can(ctx.role, "usage.read") ? await usageSummary(ctx) : null,
    jobs: can(ctx.role, "operations.manage") ? await listJobs(ctx) : null,
    unknown: can(ctx.role, "operations.manage") ? await unknownActions(ctx) : [],
    audit: can(ctx.role, "audit.read") ? await listAudit(ctx, { limit: 100 }) : null,
    ai: can(ctx.role, "ai.configure") ? await getAiSettings(ctx) : null,
  }));
  const r = session.role!;
  return (
    <>
      <PageHeader
        title="Settings & Usage"
        description="Workspace controls, AI models and keys, budgets, usage, operations and the immutable audit log."
      />
      <SettingsClient
        data={serialize(data!) as never}
        isOwner={r === "owner"}
        canManage={can(r, "workspace.manage")}
        canKill={can(r, "workspace.kill_switch")}
        appEnv={env().APP_ENV}
        testMode={env().META_ADS_TEST_MODE}
      />
    </>
  );
}
