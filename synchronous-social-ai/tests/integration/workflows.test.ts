import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { as, drain, makeTenant, type Tenant } from "../helpers";
import { withSystem, withTenant } from "@/server/db/tenant";
import * as s from "@/server/db/schema";
import { decide, getApproval, listApprovals, requestApproval } from "@/server/services/approvals";
import { addVersion, contentDetail, createContent, requestPublishApproval, updateSchedule } from "@/server/services/content";
import { connectMockAccount, setAdapterOverridesForTests } from "@/server/services/integrations";
import { uploadMedia, createGeneration, getGeneration, cancelGeneration, setMediaProviderForTests } from "@/server/services/media";
import { mockPng, MockMediaProvider, type MediaProvider } from "@/server/providers/higgsfield/higgsfield";
import { MockInstagramAdapter } from "@/server/providers/meta/instagram";
import { ProviderError } from "@/server/providers/errors";
import { setKillSwitch, updateSettings } from "@/server/services/workspace";
import { createPromotionFromRequest, planPromotion, promotionReview, updatePromotion } from "@/server/services/promotions";
import { addAllowedDomain, upsertProduct } from "@/server/services/company-brain";
import { createAdDraft, requestLaunch, updateAdDraft, adDetail } from "@/server/services/ads";
import { resolveUnknownAction } from "@/server/services/operations";

afterEach(() => {
  setAdapterOverridesForTests({ instagram: null, ads: null });
  setMediaProviderForTests(undefined);
});

async function readyPost(t: Tenant, caption = "Meet our new candle") {
  const acct = await as(t, (ctx) => connectMockAccount(ctx, "instagram"));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  const asset = await as(t, (ctx) => uploadMedia(ctx, { name: "a.jpg", type: "image/jpeg", data: jpeg }));
  const item = await as(t, (ctx) => createContent(ctx, { title: "Launch", format: "post", connectedAccountId: acct.id, version: { caption, altText: "A candle", mediaAssetIds: [asset.id], hashtags: ["candles"] } }));
  return { acct, asset, item };
}

describe("content → approval → publish (mock Instagram)", () => {
  it("publishes only after approval, records provider IDs, and labels mock results", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    await drain();
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("draft");
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    expect(ap.tier).toBe(3);
    await drain();
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("in_review");
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    const d = await as(t, (ctx) => contentDetail(ctx, item.id));
    expect(d.item.status).toBe("published");
    expect(d.item.publishMode).toBe("mock");
    expect(d.item.publishedMediaId).toMatch(/^mock_media_/);
    expect(d.actions[0]).toMatchObject({ status: "succeeded", mode: "mock" });
    expect((await as(t, (ctx) => getApproval(ctx, ap.id))).approval.status).toBe("executed");
  });

  it("editing the caption invalidates approval (no publish)", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    const r = await as(t, (ctx) => addVersion(ctx, item.id, { caption: "Edited caption", altText: "A candle", mediaAssetIds: (ap.payload as { media: Array<{ id: string }> }).media.map((m) => m.id) }));
    expect(r.invalidated).toBe(1);
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await as(t, (ctx) => getApproval(ctx, ap.id))).approval.status).toBe("invalidated");
  });

  it("changing the schedule after approval invalidates it before execution", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    await as(t, (ctx) => updateSchedule(ctx, item.id, { scheduledAt: new Date(Date.now() + 86400_000).toISOString() }));
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("scheduled");
    await as(t, (ctx) => updateSchedule(ctx, item.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() }));
    expect((await as(t, (ctx) => getApproval(ctx, ap.id))).approval.status).toBe("invalidated");
  });

  it("approval bypass: a stale payload hash, an agent actor, or the wrong tier role are all refused", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: "0".repeat(64) }))).rejects.toMatchObject({ code: "APPROVAL_INVALIDATED" });
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }), { actorType: "agent" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }), { role: "creator" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Directly enqueueing the publish job without an approval is blocked by the executor.
    await withTenant(t.workspaceId, (tx) => tx.insert(s.jobs).values({ type: "content.publish", workspaceId: t.workspaceId, payload: { contentItemId: item.id, approvalId: ap.id } }));
    await drain();
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).not.toBe("published");
  });

  it("rejection with reason returns content to draft", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "reject", payloadHash: ap.payloadHash }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "reject", reason: "Off brand", payloadHash: ap.payloadHash }));
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("draft");
  });

  it("kill switch blocks approved publishing; jobs stay queued until it is lifted", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await as(t, (ctx) => setKillSwitch(ctx, true, "test"));
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).not.toBe("published");
    const queued = await withSystem((tx) => tx.select().from(s.jobs).where(and(eq(s.jobs.workspaceId, t.workspaceId), eq(s.jobs.type, "content.publish"))));
    expect(queued[0]?.status).toBe("queued");
    await as(t, (ctx) => setKillSwitch(ctx, false));
    await drain();
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("published");
  });

  it("transient provider failure retries; permanent failure is visible and recoverable", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t, "Hello [mock:denied]");
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    const d = await as(t, (ctx) => contentDetail(ctx, item.id));
    expect(d.item.status).toBe("failed");
    expect(d.item.lastError).toMatch(/permission/i);
  });

  it("ambiguous provider outcome is never blindly retried: it is reconciled or left for a human", async () => {
    const t = await makeTenant();
    const { item } = await readyPost(t);
    let publishCalls = 0;
    setAdapterOverridesForTests({
      instagram: (a) => {
        const m = new MockInstagramAdapter(a.externalId);
        m.publishContainer = async () => {
          publishCalls++;
          throw new ProviderError("unknown_outcome", "instagram", "socket hang up");
        };
        return m;
      },
    });
    const ap = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    await withSystem((tx) => tx.update(s.jobs).set({ runAt: new Date() }).where(and(eq(s.jobs.workspaceId, t.workspaceId), eq(s.jobs.status, "queued"))));
    await drain();
    expect(publishCalls).toBe(1);
    const action = (await as(t, (ctx) => contentDetail(ctx, item.id))).actions[0]!;
    expect(action.status).toBe("unknown");
    await as(t, (ctx) => resolveUnknownAction(ctx, action.id, "not_sent", "Checked Instagram: not posted"));
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("failed");
  });
});

describe("media generation", () => {
  it("shows not-connected when no provider is configured", async () => {
    const t = await makeTenant();
    setMediaProviderForTests(null);
    await expect(as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "a candle", params: {}, clientRequestId: "req-00000001" }))).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONNECTED" });
  });
  it("completes asynchronously with the mock and stores a labelled asset; duplicate requests are idempotent", async () => {
    const t = await makeTenant();
    setMediaProviderForTests(new MockMediaProvider());
    const g1 = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "a candle", params: {}, clientRequestId: "req-00000002" }));
    const g2 = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "a candle", params: {}, clientRequestId: "req-00000002" }));
    expect(g2.id).toBe(g1.id);
    for (let i = 0; i < 6; i++) {
      await withSystem((tx) => tx.update(s.jobs).set({ runAt: new Date() }).where(and(eq(s.jobs.workspaceId, t.workspaceId), eq(s.jobs.status, "queued"))));
      await drain();
    }
    const done = await as(t, (ctx) => getGeneration(ctx, g1.id));
    expect(done.status).toBe("completed");
    const asset = await withTenant(t.workspaceId, (tx) => tx.select().from(s.mediaAssets).where(eq(s.mediaAssets.generationJobId, g1.id)));
    expect(asset[0]?.origin).toBe("mock_generated");
  });
  it("maps provider failure, moderation and timeout to clear failure states", async () => {
    const t = await makeTenant();
    setMediaProviderForTests(new MockMediaProvider());
    const fail = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "x [mock:fail]", params: {}, clientRequestId: "req-00000003" }));
    const nsfw = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "x [mock:nsfw]", params: {}, clientRequestId: "req-00000004" }));
    const slow = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "x [mock:slow]", params: {}, clientRequestId: "req-00000005" }));
    await withTenant(t.workspaceId, (tx) => tx.update(s.mediaGenerationJobs).set({ timeoutAt: new Date(Date.now() + 200) }).where(eq(s.mediaGenerationJobs.id, slow.id)));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 60));
      await withSystem((tx) => tx.update(s.jobs).set({ runAt: new Date() }).where(and(eq(s.jobs.workspaceId, t.workspaceId), eq(s.jobs.status, "queued"))));
      await drain();
    }
    expect((await as(t, (ctx) => getGeneration(ctx, fail.id))).status).toBe("failed");
    expect((await as(t, (ctx) => getGeneration(ctx, nsfw.id))).status).toBe("nsfw");
    expect((await as(t, (ctx) => getGeneration(ctx, slow.id))).status).toBe("timed_out");
  });
  it("auth errors from the provider fail permanently (no retry storm)", async () => {
    const t = await makeTenant();
    const p: MediaProvider = Object.assign(new MockMediaProvider(), { submit: async () => { throw new ProviderError("auth", "higgsfield", "Invalid credentials"); } });
    setMediaProviderForTests(p);
    const g = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "x", params: {}, clientRequestId: "req-00000006" }));
    await drain();
    expect((await as(t, (ctx) => getGeneration(ctx, g.id))).status).toBe("failed");
  });
  it("queued generations can be cancelled", async () => {
    const t = await makeTenant();
    setMediaProviderForTests(new MockMediaProvider());
    const g = await as(t, (ctx) => createGeneration(ctx, { modelId: "higgsfield-soul-v2", prompt: "x", params: {}, clientRequestId: "req-00000007" }));
    expect((await as(t, (ctx) => cancelGeneration(ctx, g.id))).canceled).toBe(true);
    expect(mockPng(2, 2).length).toBeGreaterThan(0);
  });
});

describe("promotion workflow & ads", () => {
  async function setup() {
    const t = await makeTenant();
    await as(t, (ctx) => addAllowedDomain(ctx, "shop.example.com"));
    const product = await as(t, (ctx) => upsertProduct(ctx, { name: "Aurora Candle", url: "https://shop.example.com/aurora", priceMinor: 2500, currency: "USD", keywords: ["candle"] }));
    return { t, product };
  }

  it("asks for missing details instead of guessing, then plans coordinated drafts with separate channels", async () => {
    const { t, product } = await setup();
    const r = await as(t, (ctx) => createPromotionFromRequest(ctx, "Run 50% off on our products for three days"));
    expect(r.questions.length).toBeGreaterThanOrEqual(5);
    expect(r.promotion.status).toBe("needs_input");
    await expect(as(t, (ctx) => planPromotion(ctx, r.promotion.id, { includeAds: false }))).rejects.toMatchObject({ code: "NEEDS_INPUT" });
    const start = new Date(Date.now() + 86400_000);
    const end = new Date(start.getTime() + 3 * 86400_000);
    await expect(as(t, (ctx) => updatePromotion(ctx, r.promotion.id, { landingPageUrl: "https://evil.example.org/sale" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const u = await as(t, (ctx) =>
      updatePromotion(ctx, r.promotion.id, { eligibleProductIds: [product.id], startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "America/New_York", landingPageUrl: "https://shop.example.com/sale", terms: "One per customer.", adBudgetMinor: 30000 }),
    );
    expect(u.promotion.status).toBe("ready");
    const plan = await as(t, (ctx) => planPromotion(ctx, r.promotion.id, { includeAds: true }));
    expect(plan.contentIds).toHaveLength(3);
    const review = await as(t, (ctx) => promotionReview(ctx, r.promotion.id));
    expect(review.issues.filter((i) => i.severity === "block")).toHaveLength(0);
    expect(review.channels).toMatchObject({ organic: "not_requested", messages: "draft_only", ads: "not_requested", commerce: "not_connected" });
    // Editing an asset to a different discount is caught by the consistency validator.
    await as(t, (ctx) => addVersion(ctx, plan.contentIds[0]!, { caption: "Now 40% off!" }));
    const review2 = await as(t, (ctx) => promotionReview(ctx, r.promotion.id));
    expect(review2.issues.some((i) => i.severity === "block" && /40%/.test(i.message))).toBe(true);
  });

  it("ad launch is blocked over the spend cap and requires its own approval; test mode never activates", async () => {
    const { t } = await setup();
    const acct = await as(t, (ctx) => connectMockAccount(ctx, "meta_ads"));
    const start = new Date(Date.now() + 3600_000);
    const ad = await as(t, (ctx) =>
      createAdDraft(ctx, {
        name: "Sale",
        objective: "OUTCOME_TRAFFIC",
        accountId: acct.id,
        dailyBudgetMinor: 5000,
        currency: "USD",
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3 * 86400_000).toISOString(),
        destinationUrl: "https://shop.example.com/sale",
        audience: { countries: ["US"], ageMin: 25, ageMax: 54, interests: ["Candles"] },
        placements: ["instagram_feed"],
        creatives: [{ headline: "50% off", primaryText: "50% off candles" }],
      }),
    );
    // Test mode skips the cap; turn it off for this test to check enforcement.
    process.env.META_ADS_TEST_MODE = "false";
    (await import("@/server/env")).resetEnvCache();
    try {
      await as(t, (ctx) => updateSettings(ctx, { monthlyAdSpendCapMinor: 10000 }));
      await expect(as(t, (ctx) => requestLaunch(ctx, ad.id))).rejects.toMatchObject({ code: "SPEND_CAP_EXCEEDED" });
      await as(t, (ctx) => updateSettings(ctx, { monthlyAdSpendCapMinor: 1_000_000 }));
    } finally {
      process.env.META_ADS_TEST_MODE = "true";
      (await import("@/server/env")).resetEnvCache();
    }
    const ap = await as(t, (ctx) => requestLaunch(ctx, ad.id));
    expect(ap.tier).toBe(4);
    // A budget change invalidates the launch approval.
    await as(t, (ctx) => updateAdDraft(ctx, ad.id, { dailyBudgetMinor: 6000 }));
    expect((await as(t, (ctx) => getApproval(ctx, ap.id))).approval.status).toBe("invalidated");
    const ap2 = await as(t, (ctx) => requestLaunch(ctx, ad.id));
    await as(t, (ctx) => decide(ctx, ap2.id, { decision: "approve", payloadHash: ap2.payloadHash }));
    await drain();
    const d = await as(t, (ctx) => adDetail(ctx, ad.id));
    expect(d.ad.status).toBe("launched_paused");
    expect(d.ad.externalCampaignId).toMatch(/^mock_campaign_/);
    expect(d.snapshots).toHaveLength(0);
  });

  it("two-person approval for budgets above the threshold", async () => {
    const { t } = await setup();
    const acct = await as(t, (ctx) => connectMockAccount(ctx, "meta_ads"));
    await as(t, (ctx) => updateSettings(ctx, { settings: { twoPersonApprovalAdBudgetMinor: 1000 } }));
    const start = new Date(Date.now() + 3600_000);
    const ad = await as(t, (ctx) => createAdDraft(ctx, { name: "Big", objective: "OUTCOME_TRAFFIC", accountId: acct.id, dailyBudgetMinor: 5000, currency: "USD", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 86400_000).toISOString(), destinationUrl: "https://shop.example.com/x", audience: { countries: ["US"], ageMin: 18, ageMax: 65 }, placements: ["instagram_feed"], creatives: [{ headline: "h", primaryText: "p" }] }));
    const ap = await as(t, (ctx) => requestLaunch(ctx, ad.id));
    expect(ap.requiredApprovals).toBe(2);
    await expect(as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const pending = await as(t, (ctx) => listApprovals(ctx, { status: "pending" }));
    expect(pending.some((p) => p.id === ap.id)).toBe(true);
  });

  it("approval subjects refuse tier 0-2 actions", async () => {
    const t = await makeTenant();
    await expect(as(t, (ctx) => requestApproval(ctx, { actionType: "edit_draft", subjectId: t.workspaceId }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await withSystem((tx) => tx.execute(sql`select 1`))).rows).toHaveLength(1);
  });
});
