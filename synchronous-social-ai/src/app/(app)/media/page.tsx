import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { HIGGSFIELD_MODELS } from "@/server/providers/higgsfield/higgsfield";
import { listGenerations, listMedia, mediaProviderStatus } from "@/server/services/media";
import { MediaClient } from "./client";

export const metadata = { title: "Media Library" };
export const dynamic = "force-dynamic";

export default async function MediaPage() {
  const { data, session, allowed } = await loadPage(
    async (ctx) => ({
      media: await listMedia(ctx, 120),
      jobs: await listGenerations(ctx, 30),
      provider: mediaProviderStatus(),
    }),
    { permission: "content.read" },
  );
  if (!allowed) return <Forbidden what="the Media Library" />;
  const models = HIGGSFIELD_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    kind: m.kind,
    docs: m.docs,
    defaultParams: m.defaultParams,
  }));
  return (
    <>
      <PageHeader
        title="Media Library"
        description="Uploads and provider-generated assets in tenant-controlled storage, with rights and consent metadata. Mock outputs are visibly marked."
      />
      <MediaClient
        data={serialize(data!) as never}
        models={models}
        canWrite={can(session.role!, "content.write")}
        canGenerate={can(session.role!, "media.generate")}
      />
    </>
  );
}
