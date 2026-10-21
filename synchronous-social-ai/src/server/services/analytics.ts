import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { registerJob } from "../queue/runtime";
import { getAccount, instagramAdapter } from "./integrations";
import { knownSpendMinor } from "./ads";
import { inboxMetrics } from "./inbox";
import { pendingApprovalCount } from "./approvals";
import { getProfile } from "./company-brain";

export const IG_MEDIA_METRICS = ["reach", "likes", "comments", "saved", "shares", "views"];

/** Deterministic derived metrics. Returns null when an input is missing: nothing is imputed. */
export function derived(m: { impressions: number | null; clicks: number | null; spendMinor: number | null; conversions: number | null }) {
  const ok = (n: number | null): n is number => n !== null && Number.isFinite(n);
  return {
    ctr: ok(m.impressions) && ok(m.clicks) && m.impressions > 0 ? m.clicks / m.impressions : null,
    cpcMinor: ok(m.spendMinor) && ok(m.clicks) && m.clicks > 0 ? m.spendMinor / m.clicks : null,
    cpmMinor: ok(m.spendMinor) && ok(m.impressions) && m.impressions > 0 ? (m.spendMinor / m.impressions) * 1000 : null,
    cpaMinor: ok(m.spendMinor) && ok(m.conversions) && m.conversions > 0 ? m.spendMinor / m.conversions : null,
  };
}

export async function analyticsOverview(ctx: Ctx) {
  requirePermission(ctx, "analytics.read");
  const content = await ctx.tx.execute<{ content_item_id: string; title: string; format: string; metrics: Record<string, number>; window_label: string; source: string; fetched_at: Date; published_at: Date | null; permalink: string | null }>(sql`
    select distinct on (m.content_item_id) m.content_item_id, c.title, c.format, m.metrics, m.window_label, m.source, m.fetched_at, c.published_at, c.permalink
    from content_metrics_snapshots m join content_items c on c.id = m.content_item_id
    where m.workspace_id = ${ctx.workspaceId} and m.source <> 'mock'
    order by m.content_item_id, m.fetched_at desc`);
  const ads = await ctx.tx.execute<{ ad_campaign_id: string; name: string; impressions: number | null; reach: number | null; clicks: number | null; spend_minor: number | null; conversions: number | null; currency: string | null; date_start: string; date_stop: string; attribution_window: string | null; source: string; fetched_at: Date }>(sql`
    select distinct on (m.ad_campaign_id) m.ad_campaign_id, a.name, m.impressions, m.reach, m.clicks, m.spend_minor, m.conversions, m.currency, m.date_start, m.date_stop, m.attribution_window, m.source, m.fetched_at
    from ad_metrics_snapshots m join ad_campaigns a on a.id = m.ad_campaign_id
    where m.workspace_id = ${ctx.workspaceId} and m.source = 'meta_insights'
    order by m.ad_campaign_id, m.fetched_at desc`);
  const published = await ctx.tx.select({ c: sql<number>`count(*)::int`, mock: sql<number>`count(*) filter (where ${s.contentItems.publishMode} = 'mock')::int` }).from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.status, "published")));
  const gaps: string[] = [];
  const accounts = await ctx.tx.select().from(s.connectedAccounts).where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId));
  if (!accounts.some((a) => a.provider === "instagram" && a.mode === "live" && a.status === "connected")) gaps.push("No live Instagram account connected: organic insights are unavailable.");
  if (!accounts.some((a) => a.provider === "meta_ads" && a.mode === "live" && a.status === "connected")) gaps.push("No live Meta ad account connected: ad spend and delivery metrics are unavailable.");
  if ((published[0]?.mock ?? 0) > 0) gaps.push(`${published[0]!.mock} item(s) were published to mock accounts and have no metrics.`);
  gaps.push("Link clicks from DMs and sales attribution are not tracked (no commerce/analytics integration connected).");
  return {
    publishedCount: published[0]?.c ?? 0,
    mockPublishedCount: published[0]?.mock ?? 0,
    content: content.rows.map((r) => ({ ...r, sourceLabel: "Instagram Insights API" })),
    ads: ads.rows.map((r) => ({ ...r, ...derived({ impressions: r.impressions, clicks: r.clicks, spendMinor: r.spend_minor, conversions: r.conversions }), sourceLabel: "Meta Marketing API insights" })),
    inbox: await inboxMetrics(ctx, 30),
    dataGaps: gaps,
  };
}

/** Sync organic insights for published live content. Provider errors become data gaps, not zeros. */
registerJob("analytics.sync_content", {
  async run(jc) {
    const items = await jc.tenant((ctx) =>
      ctx.tx
        .select()
        .from(s.contentItems)
        .where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.status, "published"), eq(s.contentItems.publishMode, "live"), isNotNull(s.contentItems.publishedMediaId), gte(s.contentItems.publishedAt, new Date(Date.now() - 90 * 86400_000)))),
    );
    let stored = 0;
    const errors: string[] = [];
    for (const item of items) {
      try {
        await jc.tenant(async (ctx) => {
          const ig = await instagramAdapter(ctx, await getAccount(ctx, item.connectedAccountId!));
          const metrics = await ig.getMediaInsights(item.publishedMediaId!, IG_MEDIA_METRICS);
          if (!Object.keys(metrics).length) return;
          await ctx.tx.insert(s.contentMetricsSnapshots).values({ workspaceId: ctx.workspaceId, contentItemId: item.id, externalMediaId: item.publishedMediaId!, metrics, windowLabel: "Lifetime (as of fetch)", source: "instagram_insights" });
          stored++;
        });
      } catch (e) {
        errors.push(`${item.id}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    return { stored, errors };
  },
});

// ───────────────────────────── Overview ─────────────────────────────

export async function overview(ctx: Ctx) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86400_000);
  const weekAhead = new Date(now.getTime() + 7 * 86400_000);
  const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
  const [profile, dueToday, upcoming, approvals, approvalCount, ads, promos, convs, runs, accounts, deadJobs, unknownActions, spend, recentPublished] = await Promise.all([
    getProfile(ctx),
    ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), gte(s.contentItems.scheduledAt, startOfDay), lte(s.contentItems.scheduledAt, endOfDay))).limit(20),
    ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), gte(s.contentItems.scheduledAt, now), lte(s.contentItems.scheduledAt, weekAhead), inArray(s.contentItems.status, ["scheduled", "approved", "in_review", "draft"]))).orderBy(s.contentItems.scheduledAt).limit(10),
    ctx.tx.select().from(s.approvalRequests).where(and(eq(s.approvalRequests.workspaceId, ctx.workspaceId), eq(s.approvalRequests.status, "pending"))).orderBy(desc(s.approvalRequests.tier), s.approvalRequests.createdAt).limit(5),
    pendingApprovalCount(ctx),
    ctx.tx.select().from(s.adCampaigns).where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), inArray(s.adCampaigns.status, ["active", "launched_paused", "approved", "pending_approval", "needs_reconciliation"]))),
    ctx.tx.select().from(s.promotionOffers).where(and(eq(s.promotionOffers.workspaceId, ctx.workspaceId), inArray(s.promotionOffers.status, ["ready", "active", "needs_input"]))).limit(10),
    ctx.tx.select({ status: s.inboxConversations.status, c: sql<number>`count(*)::int` }).from(s.inboxConversations).where(eq(s.inboxConversations.workspaceId, ctx.workspaceId)).groupBy(s.inboxConversations.status),
    ctx.tx.select().from(s.agentRuns).where(eq(s.agentRuns.workspaceId, ctx.workspaceId)).orderBy(desc(s.agentRuns.createdAt)).limit(8),
    ctx.tx.select().from(s.connectedAccounts).where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId)),
    ctx.tx.select({ c: sql<number>`count(*)::int` }).from(s.jobs).where(and(eq(s.jobs.workspaceId, ctx.workspaceId), eq(s.jobs.status, "dead"))),
    ctx.tx.select({ c: sql<number>`count(*)::int` }).from(s.externalActions).where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), eq(s.externalActions.status, "unknown"))),
    knownSpendMinor(ctx),
    ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.status, "published"))).orderBy(desc(s.contentItems.publishedAt)).limit(5),
  ]);
  return {
    workspace: { name: ws.name, isDemo: ws.isDemo, killSwitch: ws.killSwitch, automationPaused: ws.automationPaused, timezone: ws.timezone, currency: ws.currency, spendCapMinor: ws.monthlyAdSpendCapMinor },
    profile: { completeness: profile.score, missing: profile.missing },
    dueToday,
    upcoming,
    approvals,
    approvalCount,
    ads,
    promotions: promos,
    inbox: Object.fromEntries(convs.map((c) => [c.status, c.c])),
    runs,
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      mode: a.mode,
      displayName: a.displayName,
      status: a.status,
      tokenExpiresAt: a.tokenExpiresAt,
      expiringSoon: Boolean(a.tokenExpiresAt && a.tokenExpiresAt.getTime() - Date.now() < 7 * 86400_000),
      healthError: a.healthError,
    })),
    failedJobs: deadJobs[0]?.c ?? 0,
    unknownActions: unknownActions[0]?.c ?? 0,
    knownSpend: spend,
    recentPublished,
  };
}
