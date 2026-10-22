import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import * as s from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { contentDetail, listContent } from "@/server/services/content";
import { listMedia } from "@/server/services/media";
import { listProducts } from "@/server/services/company-brain";
import { listPromotions } from "@/server/services/promotions";
import { isSocialChannel } from "@/lib/channels";
import { ContentClient } from "./client";

export const metadata = { title: "Content Studio" };
export const dynamic = "force-dynamic";

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; new?: string; status?: string; format?: string }>;
}) {
  const sp = await searchParams;
  const { data, session, allowed } = await loadPage(
    async (ctx) => {
      const items = await listContent(ctx, {
        status: sp.status || undefined,
        format: (sp.format as never) || undefined,
      });
      const accounts = await ctx.tx
        .select()
        .from(s.connectedAccounts)
        .where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId));
      const detail = sp.id ? await contentDetail(ctx, sp.id).catch(() => null) : null;
      const ws = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]!;
      return {
        items,
        accounts: accounts.filter((a) => isSocialChannel(a.provider) && a.status !== "disconnected"),
        detail,
        media: await listMedia(ctx, 60),
        products: await listProducts(ctx),
        promotions: await listPromotions(ctx),
        timezone: ws.timezone,
      };
    },
    { permission: "content.read" },
  );
  if (!allowed) return <Forbidden what="Content Studio" />;
  return (
    <>
      <PageHeader
        title="Content Studio"
        description="Concepts, drafts, provider-generated assets, scheduled and published posts — each clearly labelled. Publishing always goes through the Approval Center."
      />
      <ContentClient
        data={serialize(data!) as never}
        canWrite={can(session.role!, "content.write")}
        canRequest={can(session.role!, "approvals.request")}
        openNew={sp.new === "1"}
        filters={{ status: sp.status ?? "", format: sp.format ?? "" }}
      />
    </>
  );
}
