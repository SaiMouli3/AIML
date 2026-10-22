import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { listIntegrations, redirectUriFor } from "@/server/services/integrations";
import { mediaProviderStatus } from "@/server/services/media";
import { env } from "@/server/env";
import { channelLabel } from "@/lib/channels";
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
    async (ctx) => ({ ...(await listIntegrations(ctx)), media: await mediaProviderStatus(ctx) }),
    { permission: "integrations.read" },
  );
  if (!allowed) return <Forbidden what="Integrations" />;
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Official platform APIs only. A channel is marked available only after credentials, permissions and a capability check succeed."
      />
      <IntegrationsClient
        data={serialize(data!) as never}
        canManage={can(session.role!, "integrations.manage")}
        canAutomate={can(session.role!, "automations.manage")}
        banner={
          sp.connected
            ? {
                tone: "success",
                text: `Connected ${sp.connected === "meta_ads" ? "Meta ad accounts" : channelLabel(sp.connected)}.`,
              }
            : sp.error
              ? { tone: "danger", text: `Connection failed: ${sp.error}` }
              : null
        }
        redirectUris={{
          instagram: redirectUriFor("instagram"),
          facebook: redirectUriFor("facebook"),
          threads: redirectUriFor("threads"),
          x: redirectUriFor("x"),
          tiktok: redirectUriFor("tiktok"),
          meta_ads: redirectUriFor("meta_ads"),
          webhook: `${env().APP_URL}/api/v1/webhooks/meta`,
        }}
      />
    </>
  );
}
