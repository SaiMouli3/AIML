import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import * as s from "@/server/db/schema";
import { env } from "@/server/env";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { adDetail, listAds } from "@/server/services/ads";
import { listProducts } from "@/server/services/company-brain";
import { listPromotions, promotionReview, ESSENTIAL_FIELDS } from "@/server/services/promotions";
import { CampaignsClient } from "./client";

export const metadata = { title: "Campaigns & Ads" };
export const dynamic = "force-dynamic";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ promotion?: string; ad?: string; new?: string; tab?: string }>;
}) {
  const sp = await searchParams;
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
      ).filter((a) => a.provider === "meta_ads");
      return {
        promotions: await listPromotions(ctx),
        ads: await listAds(ctx),
        products: await listProducts(ctx),
        accounts,
        review: sp.promotion ? await promotionReview(ctx, sp.promotion).catch(() => null) : null,
        ad: sp.ad ? await adDetail(ctx, sp.ad).catch(() => null) : null,
        workspace: { timezone: ws.timezone, currency: ws.currency, cap: ws.monthlyAdSpendCapMinor },
        questions: ESSENTIAL_FIELDS,
      };
    },
    { permission: "campaigns.read" },
  );
  if (!allowed) return <Forbidden what="Campaigns & Ads" />;
  return (
    <>
      <PageHeader
        title="Campaigns & Ads"
        description="Structured promotions with cross-asset consistency checks, and Meta ad campaigns with hard spend caps. Organic posts, messages, ads and commerce changes each need their own approval."
      />
      <CampaignsClient
        data={serialize(data!) as never}
        canWrite={can(session.role!, "campaigns.write")}
        canRequest={can(session.role!, "approvals.request")}
        testMode={env().META_ADS_TEST_MODE}
        initialTab={sp.ad || sp.tab === "ads" ? "ads" : "promotions"}
        openNew={sp.new === "promotion"}
      />
    </>
  );
}
