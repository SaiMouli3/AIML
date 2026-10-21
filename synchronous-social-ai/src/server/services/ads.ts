import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { seq } from "../lib/seq";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { checkUrl } from "../lib/url-safety";
import { checkSpendCap, evaluateAction } from "../policy/policy";
import { OBJECTIVES, SPECIAL_AD_CATEGORIES } from "../providers/meta/marketing";
import { ProviderError } from "../providers/errors";
import { storage } from "../providers/storage/storage";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { invalidateApprovalsForSubject, loadApprovalForExecution, markApprovalExecuted, registerApprovalSubject, requestApproval } from "./approvals";
import { listAllowedDomains } from "./company-brain";
import { runExternalAction } from "./external-actions";
import { adsAdapter, capabilityStatus, getAccount } from "./integrations";
import { notify } from "./notifications";
import { SENSITIVE_TERMS } from "../agents/contracts";

export const PLACEMENTS = ["instagram_feed", "instagram_stories", "instagram_reels", "instagram_explore"] as const;
const PLACEMENT_POSITIONS: Record<string, string> = { instagram_feed: "stream", instagram_stories: "story", instagram_reels: "reels", instagram_explore: "explore" };

export const audienceSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(25),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  interests: z.array(z.string().max(80)).max(15).default([]),
  rationale: z.string().max(600).default(""),
});

export const adDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.enum(OBJECTIVES),
  specialAdCategories: z.array(z.enum(SPECIAL_AD_CATEGORIES)).default(["NONE"]),
  accountId: z.uuid().nullable().optional(),
  campaignId: z.uuid().nullable().optional(),
  promotionId: z.uuid().nullable().optional(),
  dailyBudgetMinor: z.number().int().min(100).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  destinationUrl: z.url(),
  conversionEvent: z.string().max(60).nullable().optional(),
  pixelId: z.string().regex(/^\d+$/).nullable().optional(),
  audience: audienceSchema,
  placements: z.array(z.enum(PLACEMENTS)).min(1),
  creatives: z
    .array(
      z.object({
        headline: z.string().min(1).max(80),
        primaryText: z.string().min(1).max(500),
        callToAction: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "GET_OFFER"]).default("LEARN_MORE"),
        mediaAssetId: z.uuid().nullable().optional(),
        contentItemId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(4),
  agentRunId: z.uuid().optional(),
});

type AdRow = typeof s.adCampaigns.$inferSelect;

/** Validation that runs before approval is requested and again before launch. */
export async function validateAdPlan(ctx: Ctx, ad: AdRow, creatives: Array<typeof s.adCreatives.$inferSelect>) {
  const issues: string[] = [];
  if (!ad.accountId) issues.push("Select a connected Meta ad account.");
  if (ad.destinationUrl) {
    const chk = checkUrl(ad.destinationUrl, await listAllowedDomains(ctx));
    if (!chk.ok) issues.push(`Destination rejected: ${chk.reason}.`);
  } else issues.push("Destination URL is required.");
  if (!ad.startsAt) issues.push("Start time is required.");
  if (ad.startsAt && ad.endsAt && ad.endsAt <= ad.startsAt) issues.push("End must be after start.");
  if (ad.startsAt && ad.startsAt < new Date(Date.now() - 5 * 60_000)) issues.push("Start time is in the past.");
  const aud = ad.audience as z.infer<typeof audienceSchema>;
  if (aud.ageMin > aud.ageMax) issues.push("Audience minimum age exceeds maximum age.");
  const sensitive = aud.interests.filter((i) => SENSITIVE_TERMS.some((re) => re.test(i)));
  if (sensitive.length) issues.push(`Remove sensitive targeting: ${sensitive.join(", ")}.`);
  const special = ad.specialAdCategories.filter((c) => c !== "NONE");
  if (special.length && (aud.ageMin !== 18 || aud.ageMax !== 65 || aud.interests.length)) {
    issues.push("Special ad categories require broad age (18–65+) and no detailed interest targeting.");
  }
  if (ad.objective === "OUTCOME_SALES" && !ad.pixelId) issues.push("Sales objective requires a Meta Pixel/dataset ID for conversion tracking.");
  if (!creatives.length) issues.push("At least one creative is required.");
  if (ad.accountId) {
    const acct = await getAccount(ctx, ad.accountId);
    if (acct.provider !== "meta_ads") issues.push("Selected account is not a Meta ad account.");
    if (acct.status !== "connected") issues.push(`Ad account is ${acct.status}.`);
    if (acct.currency && acct.currency !== ad.currency) issues.push(`Budget currency ${ad.currency} does not match ad account currency ${acct.currency}.`);
    const cap = await capabilityStatus(ctx, acct.id, "ads_manage");
    if (cap.status !== "available") issues.push(`Ad account cannot manage ads: ${cap.reason ?? "unavailable"}.`);
    if (!(acct.settings as { pageId?: string }).pageId && acct.mode === "live") issues.push("Set the Facebook Page ID for this ad account (required for ad creatives).");
  }
  const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
  const spend = checkSpendCap({
    workspaceMonthlyCapMinor: ws.monthlyAdSpendCapMinor,
    committedThisMonthMinor: await committedSpendMinor(ctx, ad.id),
    dailyBudgetMinor: ad.dailyBudgetMinor,
    durationDays: durationDays(ad),
    testMode: env().META_ADS_TEST_MODE,
  });
  issues.push(...spend.reasons);
  return { issues, projectedMinor: spend.projectedMinor };
}

export function durationDays(ad: Pick<AdRow, "startsAt" | "endsAt">) {
  return ad.startsAt && ad.endsAt ? Math.max(1, Math.ceil((ad.endsAt.getTime() - ad.startsAt.getTime()) / 86400_000)) : null;
}

/** Budget already committed by other active/approved campaigns this calendar month (projected). */
async function committedSpendMinor(ctx: Ctx, excludeId?: string) {
  const rows = await ctx.tx
    .select()
    .from(s.adCampaigns)
    .where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), inArray(s.adCampaigns.status, ["approved", "launching", "active", "launched_paused"])));
  return rows.filter((r) => r.id !== excludeId).reduce((sum, r) => sum + r.dailyBudgetMinor * Math.min(31, durationDays(r) ?? 31), 0);
}

export async function createAdDraft(ctx: Ctx, input: z.input<typeof adDraftSchema>) {
  requirePermission(ctx, "campaigns.write");
  const v = adDraftSchema.parse(input);
  if (v.accountId) await getAccount(ctx, v.accountId);
  const [ad] = await ctx.tx
    .insert(s.adCampaigns)
    .values({
      workspaceId: ctx.workspaceId,
      name: v.name,
      objective: v.objective,
      specialAdCategories: v.specialAdCategories,
      accountId: v.accountId ?? null,
      campaignId: v.campaignId ?? null,
      promotionId: v.promotionId ?? null,
      dailyBudgetMinor: v.dailyBudgetMinor,
      currency: v.currency,
      startsAt: v.startsAt ? new Date(v.startsAt) : null,
      endsAt: v.endsAt ? new Date(v.endsAt) : null,
      timezone: v.timezone ?? null,
      destinationUrl: v.destinationUrl,
      conversionEvent: v.conversionEvent ?? null,
      pixelId: v.pixelId ?? null,
      audience: v.audience,
      placements: v.placements,
      status: "draft",
      createdBy: ctx.userId,
      agentRunId: v.agentRunId ?? null,
    })
    .returning();
  await ctx.tx.insert(s.adSets).values({
    workspaceId: ctx.workspaceId,
    adCampaignId: ad!.id,
    name: `${v.name} — ad set`,
    optimizationGoal: v.objective === "OUTCOME_SALES" ? "OFFSITE_CONVERSIONS" : v.objective === "OUTCOME_AWARENESS" ? "REACH" : "LINK_CLICKS",
    targeting: v.audience,
  });
  for (const c of v.creatives) {
    await ctx.tx.insert(s.adCreatives).values({ workspaceId: ctx.workspaceId, adCampaignId: ad!.id, headline: c.headline, primaryText: c.primaryText, callToAction: c.callToAction, mediaAssetId: c.mediaAssetId ?? null, contentItemId: c.contentItemId ?? null });
  }
  await audit(ctx, { action: "ads.draft_created", targetType: "ad_campaign", targetId: ad!.id, metadata: { dailyBudgetMinor: v.dailyBudgetMinor, currency: v.currency } });
  return ad!;
}

export async function getAd(ctx: Ctx, id: string) {
  requirePermission(ctx, "campaigns.read");
  const r = await ctx.tx.select().from(s.adCampaigns).where(and(eq(s.adCampaigns.id, id), eq(s.adCampaigns.workspaceId, ctx.workspaceId))).limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Ad campaign not found");
  return r[0];
}

export async function adDetail(ctx: Ctx, id: string) {
  const ad = await getAd(ctx, id);
  const [creatives, sets, snapshots, approvals, actions] = await seq([
    () => ctx.tx.select().from(s.adCreatives).where(eq(s.adCreatives.adCampaignId, id)),
    () => ctx.tx.select().from(s.adSets).where(eq(s.adSets.adCampaignId, id)),
    () => ctx.tx.select().from(s.adMetricsSnapshots).where(eq(s.adMetricsSnapshots.adCampaignId, id)).orderBy(desc(s.adMetricsSnapshots.fetchedAt)).limit(30),
    () => ctx.tx.select().from(s.approvalRequests).where(and(eq(s.approvalRequests.workspaceId, ctx.workspaceId), eq(s.approvalRequests.subjectId, id))).orderBy(desc(s.approvalRequests.createdAt)),
    () => ctx.tx.select().from(s.externalActions).where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), eq(s.externalActions.subjectId, id))).orderBy(desc(s.externalActions.createdAt)),
  ]);
  const validation = await validateAdPlan(ctx, ad, creatives);
  return { ad, creatives, sets, snapshots, approvals, actions, validation };
}

export async function listAds(ctx: Ctx) {
  requirePermission(ctx, "campaigns.read");
  return ctx.tx.select().from(s.adCampaigns).where(eq(s.adCampaigns.workspaceId, ctx.workspaceId)).orderBy(desc(s.adCampaigns.createdAt));
}

export const adUpdateSchema = adDraftSchema.partial().omit({ creatives: true, agentRunId: true });

/** Any edit to budget, audience, schedule, destination or creative invalidates launch approvals. */
export async function updateAdDraft(ctx: Ctx, id: string, patch: z.infer<typeof adUpdateSchema>) {
  requirePermission(ctx, "campaigns.write");
  const ad = await getAd(ctx, id);
  if (!["draft", "pending_approval", "approved", "failed"].includes(ad.status)) throw new AppError("CONFLICT", `Campaign is ${ad.status}; use pause/budget actions instead`);
  if (patch.accountId) await getAccount(ctx, patch.accountId);
  const next: Partial<AdRow> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
    ...(patch.specialAdCategories !== undefined ? { specialAdCategories: patch.specialAdCategories } : {}),
    ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
    ...(patch.dailyBudgetMinor !== undefined ? { dailyBudgetMinor: patch.dailyBudgetMinor } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt ? new Date(patch.startsAt) : null } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt ? new Date(patch.endsAt) : null } : {}),
    ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    ...(patch.destinationUrl !== undefined ? { destinationUrl: patch.destinationUrl } : {}),
    ...(patch.conversionEvent !== undefined ? { conversionEvent: patch.conversionEvent } : {}),
    ...(patch.pixelId !== undefined ? { pixelId: patch.pixelId } : {}),
    ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
    ...(patch.placements !== undefined ? { placements: patch.placements } : {}),
  };
  const invalidated = await invalidateApprovalsForSubject(ctx, id, "Campaign plan changed");
  const [updated] = await ctx.tx.update(s.adCampaigns).set({ ...next, status: "draft", version: ad.version + 1, updatedAt: new Date() }).where(eq(s.adCampaigns.id, id)).returning();
  if (patch.audience) await ctx.tx.update(s.adSets).set({ targeting: patch.audience }).where(eq(s.adSets.adCampaignId, id));
  await audit(ctx, { action: patch.dailyBudgetMinor !== undefined ? "budget.ad_budget_changed" : "ads.draft_updated", targetType: "ad_campaign", targetId: id, metadata: { fields: Object.keys(next), before: { dailyBudgetMinor: ad.dailyBudgetMinor }, invalidatedApprovals: invalidated } });
  return { ad: updated!, invalidated };
}

async function buildLaunchPayload(ctx: Ctx, id: string) {
  const ad = await getAd(ctx, id);
  const creatives = await ctx.tx.select().from(s.adCreatives).where(eq(s.adCreatives.adCampaignId, id)).orderBy(s.adCreatives.createdAt);
  const account = ad.accountId ? await getAccount(ctx, ad.accountId) : null;
  const media = creatives.map((c) => c.mediaAssetId).filter(Boolean) as string[];
  const assets = media.length ? await ctx.tx.select().from(s.mediaAssets).where(and(inArray(s.mediaAssets.id, media), eq(s.mediaAssets.workspaceId, ctx.workspaceId))) : [];
  const payload = {
    adCampaignId: ad.id,
    version: ad.version,
    accountId: account?.id ?? null,
    accountExternalId: account?.externalId ?? null,
    name: ad.name,
    objective: ad.objective,
    specialAdCategories: ad.specialAdCategories,
    dailyBudgetMinor: ad.dailyBudgetMinor,
    currency: ad.currency,
    startsAt: ad.startsAt?.toISOString() ?? null,
    endsAt: ad.endsAt?.toISOString() ?? null,
    timezone: ad.timezone,
    destinationUrl: ad.destinationUrl,
    conversionEvent: ad.conversionEvent,
    pixelId: ad.pixelId,
    audience: ad.audience,
    placements: ad.placements,
    creatives: creatives.map((c) => ({ headline: c.headline, primaryText: c.primaryText, cta: c.callToAction, media: assets.find((a) => a.id === c.mediaAssetId)?.sha256 ?? null })),
    testMode: env().META_ADS_TEST_MODE,
  };
  return { ad, creatives, account, payload, assets };
}

registerApprovalSubject("ad_launch", {
  subjectType: "ad_campaign",
  async build(ctx, id) {
    const { ad, account, payload } = await buildLaunchPayload(ctx, id);
    const days = durationDays(ad);
    const aud = ad.audience as z.infer<typeof audienceSchema>;
    return {
      version: ad.version,
      budgetMinor: ad.dailyBudgetMinor * (days ?? 31),
      executeBy: ad.startsAt,
      payload,
      summary: {
        title: `Launch Meta campaign: ${ad.name}`,
        channel: "Meta Ads (Instagram placements)",
        destination: account ? `${account.displayName} (${account.externalId})` : "No ad account",
        mode: (account?.mode as "live" | "mock" | undefined) ?? undefined,
        schedule: { at: ad.startsAt?.toISOString() ?? null, timezone: ad.timezone },
        audience: `${aud.countries.join(", ")} · ages ${aud.ageMin}–${aud.ageMax}${aud.interests.length ? ` · interests: ${aud.interests.join(", ")}` : ""} (hypothesis)`,
        budget: { amountMinor: ad.dailyBudgetMinor, currency: ad.currency, period: "daily", durationDays: days },
        landingPage: ad.destinationUrl,
        risks: [
          "Delivery, reach and results are determined by Meta's auction and ad review; nothing is guaranteed.",
          ...(ad.specialAdCategories.some((c) => c !== "NONE") ? ["Special ad category restrictions apply."] : []),
        ],
        sideEffects: [
          env().META_ADS_TEST_MODE ? "TEST MODE: objects are created PAUSED; no money will be spent." : `Spends up to ${(ad.dailyBudgetMinor / 100).toFixed(2)} ${ad.currency} per day${days ? ` for ${days} day(s)` : " until paused"}.`,
          account?.mode === "mock" ? "MOCK ad account: nothing is created at Meta." : "Creates campaign, ad set, creative and ad objects in your Meta ad account.",
        ],
      },
    };
  },
  async onApproved(ctx, approval) {
    await ctx.tx.update(s.adCampaigns).set({ status: "approved", updatedAt: new Date() }).where(eq(s.adCampaigns.id, approval.subjectId));
    await enqueue(ctx.tx, { type: "ads.launch", workspaceId: ctx.workspaceId, payload: { adCampaignId: approval.subjectId, approvalId: approval.id }, idempotencyKey: `ads.launch:${approval.id}`, correlationId: ctx.correlationId, maxAttempts: 4 });
  },
  async onClosed(ctx, approval, status) {
    const ad = await getAd(ctx, approval.subjectId).catch(() => null);
    if (ad && ["pending_approval", "approved"].includes(ad.status) && status !== "executed") {
      await ctx.tx.update(s.adCampaigns).set({ status: "draft", updatedAt: new Date() }).where(eq(s.adCampaigns.id, ad.id));
    }
  },
});

registerApprovalSubject("ad_pause", {
  subjectType: "ad_campaign",
  async build(ctx, id) {
    const ad = await getAd(ctx, id);
    return {
      payload: { adCampaignId: id, externalCampaignId: ad.externalCampaignId, action: "PAUSE" },
      summary: { title: `Pause Meta campaign: ${ad.name}`, channel: "Meta Ads", destination: ad.externalCampaignId ?? "", risks: [], sideEffects: ["Stops delivery of all ads in this campaign."] },
    };
  },
  async onApproved(ctx, approval) {
    await enqueue(ctx.tx, { type: "ads.set_status", workspaceId: ctx.workspaceId, payload: { adCampaignId: approval.subjectId, approvalId: approval.id, status: "PAUSED" }, idempotencyKey: `ads.pause:${approval.id}` });
  },
});

export async function requestLaunch(ctx: Ctx, id: string) {
  requirePermission(ctx, "approvals.request");
  const { ad, creatives } = await buildLaunchPayload(ctx, id);
  if (!["draft", "failed"].includes(ad.status) && ad.status !== "pending_approval") throw new AppError("CONFLICT", `Campaign is ${ad.status}`);
  const { issues } = await validateAdPlan(ctx, ad, creatives);
  if (issues.length) throw new AppError(issues.some((i) => i.includes("cap")) ? "SPEND_CAP_EXCEEDED" : "VALIDATION_FAILED", "Campaign is not ready for launch approval", issues);
  const approval = await requestApproval(ctx, { actionType: "ad_launch", subjectId: id });
  await ctx.tx.update(s.adCampaigns).set({ status: "pending_approval", updatedAt: new Date() }).where(eq(s.adCampaigns.id, id));
  return approval;
}

export async function requestPause(ctx: Ctx, id: string) {
  const ad = await getAd(ctx, id);
  if (!ad.externalCampaignId) throw new AppError("CONFLICT", "Campaign has not been created at Meta");
  return requestApproval(ctx, { actionType: "ad_pause", subjectId: id });
}

registerJob("ads.launch", {
  external: true,
  uncertainOnCrash: true,
  async run(jc, payload) {
    const adCampaignId = String(payload.adCampaignId);
    const approvalId = String(payload.approvalId);
    const res = await runExternalAction(jc, {
      actionType: "ad_launch",
      provider: "meta_ads",
      accountId: null,
      subjectType: "ad_campaign",
      subjectId: adCampaignId,
      idempotencyKey: `ad_launch:${approvalId}`,
      approvalRequestId: approvalId,
      async authorize(ctx) {
        const { approval, currentHash } = await loadApprovalForExecution(ctx, approvalId);
        const { ad, creatives, account } = await buildLaunchPayload(ctx, adCampaignId);
        const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
        const decision = evaluateAction({
          actionType: "ad_launch",
          actorType: "worker",
          workspace: ws,
          accountId: account?.id,
          account: account ? { automationPaused: account.automationPaused, status: account.status, mode: account.mode } : null,
          currentPayloadHash: currentHash,
          approval,
          mocksAllowed: env().mocksAllowed,
        });
        if (!decision.allowed) throw new AppError("POLICY_BLOCKED", decision.reasons.join(" "));
        // Hard spend cap re-checked immediately before the mutation.
        const { issues } = await validateAdPlan(ctx, { ...ad, status: "draft" }, creatives);
        const blocking = issues.filter((i) => !i.includes("Start time is in the past"));
        if (blocking.length) throw new AppError("SPEND_CAP_EXCEEDED", blocking.join(" "));
        await ctx.tx.update(s.adCampaigns).set({ status: "launching", updatedAt: new Date() }).where(eq(s.adCampaigns.id, adCampaignId));
        return { payloadHash: currentHash, mode: account!.mode as "live" | "mock" };
      },
      async execute(ctx) {
        const { ad, creatives, account, assets } = await buildLaunchPayload(ctx, adCampaignId);
        const meta = await adsAdapter(ctx, account!);
        const aud = ad.audience as z.infer<typeof audienceSchema>;
        // Campaign name carries the approval id so an ambiguous create can be found during reconciliation.
        const tagName = `${ad.name} [ssa:${approvalId.slice(0, 8)}]`;
        const campaign = await meta.createCampaign({ name: tagName, objective: ad.objective as never, specialAdCategories: ad.specialAdCategories });
        const set = await meta.createAdSet({
          name: `${ad.name} — ad set`,
          campaignId: campaign.id,
          dailyBudgetMinor: ad.dailyBudgetMinor,
          optimizationGoal: ad.objective === "OUTCOME_SALES" ? "OFFSITE_CONVERSIONS" : ad.objective === "OUTCOME_AWARENESS" ? "REACH" : "LINK_CLICKS",
          billingEvent: "IMPRESSIONS",
          targeting: {
            geo_locations: { countries: aud.countries },
            age_min: aud.ageMin,
            age_max: aud.ageMax,
            publisher_platforms: ["instagram"],
            instagram_positions: ad.placements.map((p) => PLACEMENT_POSITIONS[p]).filter(Boolean),
          },
          startTime: ad.startsAt?.toISOString() ?? null,
          endTime: ad.endsAt?.toISOString() ?? null,
          promotedObject: ad.objective === "OUTCOME_SALES" && ad.pixelId ? { pixel_id: ad.pixelId, custom_event_type: ad.conversionEvent ?? "PURCHASE" } : null,
        });
        const created: Array<{ creativeId: string; adId: string; rowId: string }> = [];
        for (const c of creatives) {
          const asset = assets.find((a) => a.id === c.mediaAssetId);
          const creative = await meta.createCreative({
            name: `${ad.name} — ${c.headline}`,
            pageId: (account!.settings as { pageId?: string }).pageId ?? "mock_page",
            link: ad.destinationUrl!,
            message: c.primaryText,
            headline: c.headline,
            imageUrl: asset ? await storage().signedUrl(asset.storageKey, 3600) : null,
            callToAction: c.callToAction,
          });
          const adObj = await meta.createAd(`${ad.name} — ${c.headline}`, set.id, creative.id);
          created.push({ creativeId: creative.id, adId: adObj.id, rowId: c.id });
        }
        let activated = false;
        if (!env().META_ADS_TEST_MODE && meta.mode === "live") {
          await meta.setStatus(campaign.id, "ACTIVE");
          await meta.setStatus(set.id, "ACTIVE");
          for (const c of created) await meta.setStatus(c.adId, "ACTIVE");
          activated = true;
        }
        return { providerRef: campaign.id, summary: { adSetId: set.id, ads: created, activated, testMode: env().META_ADS_TEST_MODE, mode: meta.mode } };
      },
      async reconcile(ctx) {
        const { ad, account } = await buildLaunchPayload(ctx, adCampaignId);
        const meta = await adsAdapter(ctx, account!);
        if (meta.mode === "mock") return null;
        const hit = await meta.findCampaignByName(`${ad.name} [ssa:${approvalId.slice(0, 8)}]`);
        // A found campaign may be partially built: report it for human review instead of rebuilding.
        return hit ? { found: true, result: { providerRef: hit.id, summary: { reconciled: true, partial: true, status: hit.status } } } : { found: false };
      },
      async onSuccess(ctx, result, row) {
        const summary = result.summary as { adSetId?: string; ads?: Array<{ creativeId: string; adId: string; rowId: string }>; activated?: boolean; partial?: boolean };
        await ctx.tx
          .update(s.adCampaigns)
          .set({ status: summary.partial ? "needs_reconciliation" : summary.activated ? "active" : "launched_paused", externalCampaignId: result.providerRef, mode: row.mode, providerStatus: summary.activated ? "ACTIVE" : "PAUSED", lastError: null, updatedAt: new Date() })
          .where(eq(s.adCampaigns.id, adCampaignId));
        if (summary.adSetId) await ctx.tx.update(s.adSets).set({ externalId: summary.adSetId }).where(eq(s.adSets.adCampaignId, adCampaignId));
        for (const a of summary.ads ?? []) await ctx.tx.update(s.adCreatives).set({ externalCreativeId: a.creativeId, externalAdId: a.adId }).where(eq(s.adCreatives.id, a.rowId));
        await markApprovalExecuted(ctx, approvalId);
        await notify(ctx, {
          kind: "ad_launched",
          title: row.mode === "mock" ? "Mock ad launch recorded (nothing created at Meta)" : summary.activated ? "Meta campaign launched (active)" : "Meta campaign created in PAUSED state (test mode)",
          link: `/campaigns?ad=${adCampaignId}`,
        });
      },
      async onFailure(ctx, error, final) {
        await ctx.tx.update(s.adCampaigns).set({ status: final ? "failed" : "launching", lastError: error, updatedAt: new Date() }).where(eq(s.adCampaigns.id, adCampaignId));
        if (final) await notify(ctx, { kind: "ad_launch_failed", title: "Ad launch failed", body: error, link: `/campaigns?ad=${adCampaignId}` });
      },
    });
    return { status: res.status };
  },
});

registerJob("ads.set_status", {
  external: true,
  async run(jc, payload) {
    const adCampaignId = String(payload.adCampaignId);
    const approvalId = String(payload.approvalId);
    const target = payload.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
    const res = await runExternalAction(jc, {
      actionType: target === "ACTIVE" ? "ad_resume" : "ad_pause",
      provider: "meta_ads",
      accountId: null,
      subjectType: "ad_campaign",
      subjectId: adCampaignId,
      idempotencyKey: `ad_status:${approvalId}`,
      approvalRequestId: approvalId,
      async authorize(ctx) {
        const { approval, currentHash } = await loadApprovalForExecution(ctx, approvalId);
        const ad = await getAd(ctx, adCampaignId);
        const account = ad.accountId ? await getAccount(ctx, ad.accountId) : null;
        const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
        const d = evaluateAction({ actionType: target === "ACTIVE" ? "ad_resume" : "ad_pause", actorType: "worker", workspace: ws, account: account ? { automationPaused: account.automationPaused, status: account.status, mode: account.mode } : null, currentPayloadHash: currentHash, approval, mocksAllowed: env().mocksAllowed });
        if (!d.allowed) throw new AppError("POLICY_BLOCKED", d.reasons.join(" "));
        return { payloadHash: currentHash, mode: account!.mode as "live" | "mock" };
      },
      async execute(ctx) {
        const ad = await getAd(ctx, adCampaignId);
        const meta = await adsAdapter(ctx, await getAccount(ctx, ad.accountId!));
        if (!ad.externalCampaignId) throw new ProviderError("invalid", "meta_ads", "No external campaign");
        await meta.setStatus(ad.externalCampaignId, target);
        return { providerRef: ad.externalCampaignId, summary: { status: target } };
      },
      async reconcile(ctx) {
        const ad = await getAd(ctx, adCampaignId);
        const meta = await adsAdapter(ctx, await getAccount(ctx, ad.accountId!));
        const obj = await meta.getObject(ad.externalCampaignId!);
        return obj.status === target ? { found: true, result: { providerRef: obj.id, summary: { status: target, reconciled: true } } } : { found: false };
      },
      async onSuccess(ctx) {
        await ctx.tx.update(s.adCampaigns).set({ status: target === "ACTIVE" ? "active" : "paused", providerStatus: target, updatedAt: new Date() }).where(eq(s.adCampaigns.id, adCampaignId));
        await markApprovalExecuted(ctx, approvalId);
      },
      async onFailure(ctx, error) {
        await ctx.tx.update(s.adCampaigns).set({ lastError: error, updatedAt: new Date() }).where(eq(s.adCampaigns.id, adCampaignId));
      },
    });
    return { status: res.status };
  },
});

/** Insights sync: stores provider-reported metrics with their window. Mock accounts produce no metrics. */
registerJob("ads.sync_insights", {
  async run(jc) {
    return jc.tenant(async (ctx) => {
      const ads = await ctx.tx
        .select()
        .from(s.adCampaigns)
        .where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), inArray(s.adCampaigns.status, ["active", "launched_paused", "paused", "completed"])));
      let stored = 0;
      for (const ad of ads) {
        if (!ad.externalCampaignId || !ad.accountId) continue;
        const acct = await getAccount(ctx, ad.accountId);
        if (acct.mode === "mock") continue;
        const meta = await adsAdapter(ctx, acct);
        const until = new Date().toISOString().slice(0, 10);
        const since = (ad.startsAt ?? new Date(Date.now() - 28 * 86400_000)).toISOString().slice(0, 10);
        const ins = await meta.getInsights(ad.externalCampaignId, since, until);
        if (!ins) continue;
        await ctx.tx.insert(s.adMetricsSnapshots).values({
          workspaceId: ctx.workspaceId,
          adCampaignId: ad.id,
          dateStart: ins.dateStart,
          dateStop: ins.dateStop,
          impressions: ins.impressions,
          reach: ins.reach,
          clicks: ins.clicks,
          spendMinor: ins.spend !== null ? Math.round(ins.spend * 100) : null,
          conversions: ins.conversions,
          currency: acct.currency ?? ad.currency,
          attributionWindow: "Meta default (7-day click, 1-day view)",
          source: "meta_insights",
        });
        stored++;
      }
      return { stored };
    });
  },
});

/** Known spend: latest provider-reported cumulative spend per campaign (snapshots are cumulative windows). */
export async function knownSpendMinor(ctx: Ctx) {
  const r = await ctx.tx.execute<{ total: string | null; currency: string | null }>(sql`
    select sum(spend_minor)::text as total, max(currency) as currency from (
      select distinct on (ad_campaign_id) spend_minor, currency from ad_metrics_snapshots
      where workspace_id = ${ctx.workspaceId} and source = 'meta_insights'
      order by ad_campaign_id, fetched_at desc
    ) latest`);
  const row = r.rows[0];
  return { spendMinor: row?.total ? Number(row.total) : null, currency: row?.currency ?? null };
}
