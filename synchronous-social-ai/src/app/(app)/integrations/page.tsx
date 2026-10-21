import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { listIntegrations, redirectUriFor } from "@/server/services/integrations";
import { mediaProviderStatus } from "@/server/services/media";
import { env } from "@/server/env";
import { IntegrationsClient } from "./client";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const { data, session, allowed } = await loadPage(
    async (ctx) => ({ ...(await listIntegrations(ctx)), media: mediaProviderStatus() }),
    { permission: "integrations.read" },
  );
  if (!allowed) return <Forbidden what="Integrations" />;
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Official Meta and Higgsfield APIs only. An integration is marked available only after credentials, permissions and a live capability check succeed."
      />
      <IntegrationsClient
        data={serialize(data!) as never}
        canManage={can(session.role!, "integrations.manage")}
        canAutomate={can(session.role!, "automations.manage")}
        banner={
          sp.connected
            ? {
                tone: "success",
                text: `Connected ${sp.connected === "instagram" ? "Instagram" : "Meta ad accounts"}.`,
              }
            : sp.error
              ? { tone: "danger", text: `Connection failed: ${sp.error}` }
              : null
        }
        redirectUris={{
          instagram: redirectUriFor("instagram"),
          meta_ads: redirectUriFor("meta_ads"),
          webhook: `${env().APP_URL}/api/v1/webhooks/meta`,
        }}
      />
    </>
  );
}
