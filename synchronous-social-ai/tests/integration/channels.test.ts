import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { as, drain, makeTenant, type Tenant } from "../helpers";
import { withSystem, withTenant } from "@/server/db/tenant";
import * as s from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { sha256, decryptSecret } from "@/server/lib/crypto";
import { decide, getApproval } from "@/server/services/approvals";
import {
  contentDetail,
  createContent,
  duplicateContent,
  requestPublishApproval,
} from "@/server/services/content";
import {
  connectMockAccount,
  consumeOAuthState,
  listIntegrations,
  setPublisherOverrideForTests,
  startOAuth,
  updateAccountSettings,
} from "@/server/services/integrations";
import { conversationDetail, ingestWebhookEvents, normalizeMetaWebhook } from "@/server/services/inbox";
import { uploadMedia } from "@/server/services/media";
import { addAllowedDomain } from "@/server/services/company-brain";
import { pkceChallenge } from "@/server/providers/social/x";
import { MockTikTokAdapter } from "@/server/providers/social/tiktok";
import { ProviderError } from "@/server/providers/errors";

afterEach(() => setPublisherOverrideForTests(null));

/** Rescheduled jobs (provider still processing) become due immediately, then drain again. */
async function advance() {
  await withSystem((tx) => tx.update(s.jobs).set({ runAt: new Date() }).where(eq(s.jobs.status, "queued")));
  await drain();
}

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
// Minimal ISO-BMFF header ("ftyp") so the upload sniffs as MP4.
const mp4 = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(200, 0)]);

async function approveAndPublish(t: Tenant, itemId: string) {
  const ap = await as(t, (ctx) => requestPublishApproval(ctx, itemId));
  await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
  await drain();
  return ap;
}

describe("multi-channel publishing (mock accounts)", () => {
  it("Facebook text post and X post publish after approval with channel-specific summaries", async () => {
    const t = await makeTenant();
    const fb = await as(t, (ctx) => connectMockAccount(ctx, "facebook"));
    const x = await as(t, (ctx) => connectMockAccount(ctx, "x"));
    const fbItem = await as(t, (ctx) =>
      createContent(ctx, {
        title: "FB",
        format: "post",
        connectedAccountId: fb.id,
        version: { caption: "Hello Facebook" },
      }),
    );
    const ap = await approveAndPublish(t, fbItem.id);
    expect(ap.summary).toMatchObject({ channel: "Facebook", mode: "mock" });
    expect((ap.summary as { sideEffects: string[] }).sideEffects[0]).toMatch(
      /nothing will be posted to Facebook/,
    );
    const d = await as(t, (ctx) => contentDetail(ctx, fbItem.id));
    expect(d.item).toMatchObject({ status: "published", publishMode: "mock" });
    expect(d.actions[0]).toMatchObject({ provider: "facebook", status: "succeeded" });

    const xItem = await as(t, (ctx) =>
      createContent(ctx, {
        title: "X",
        format: "post",
        connectedAccountId: x.id,
        version: { caption: "Hello X" },
      }),
    );
    await approveAndPublish(t, xItem.id);
    expect((await as(t, (ctx) => contentDetail(ctx, xItem.id))).item.status).toBe("published");
  });

  it("platform rules block approval: X 280 characters, TikTok needs a video", async () => {
    const t = await makeTenant();
    const x = await as(t, (ctx) => connectMockAccount(ctx, "x"));
    const tt = await as(t, (ctx) => connectMockAccount(ctx, "tiktok"));
    const long = await as(t, (ctx) =>
      createContent(ctx, {
        title: "Long",
        format: "post",
        connectedAccountId: x.id,
        version: { caption: "a".repeat(300) },
      }),
    );
    await expect(as(t, (ctx) => requestPublishApproval(ctx, long.id))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.arrayContaining(["X allows 280 characters; this has 300."]),
    });
    const noVideo = await as(t, (ctx) =>
      createContent(ctx, {
        title: "TT",
        format: "reel",
        connectedAccountId: tt.id,
        version: { caption: "hi" },
      }),
    );
    await expect(as(t, (ctx) => requestPublishApproval(ctx, noVideo.id))).rejects.toMatchObject({
      details: expect.arrayContaining(["TikTok videos need exactly one video."]),
    });
  });

  it("TikTok: processing state is persisted and resumed; privacy level is part of the approved payload", async () => {
    const t = await makeTenant();
    const tt = await as(t, (ctx) => connectMockAccount(ctx, "tiktok"));
    expect(tt.settings.tiktokPrivacy).toBe("SELF_ONLY");
    const v = await as(t, (ctx) => uploadMedia(ctx, { name: "v.mp4", type: "video/mp4", data: mp4() }));
    let publishes = 0;
    const mock = new MockTikTokAdapter(tt.externalId);
    setPublisherOverrideForTests((a) =>
      a.provider === "tiktok"
        ? Object.assign(Object.create(mock), {
            publish: (i: Parameters<typeof mock.publish>[0]) => {
              publishes++;
              expect(i.privacyLevel).toBe("MUTUAL_FOLLOW_FRIENDS");
              return mock.publish(i);
            },
          })
        : null,
    );
    const item = await as(t, (ctx) =>
      createContent(ctx, {
        title: "TT",
        format: "reel",
        connectedAccountId: tt.id,
        version: { caption: "New drop", mediaAssetIds: [v.id] },
      }),
    );
    const before = await as(t, (ctx) => requestPublishApproval(ctx, item.id));
    // Changing who can see the post changes what is being approved.
    await as(t, (ctx) => updateAccountSettings(ctx, tt.id, { tiktokPrivacy: "MUTUAL_FOLLOW_FRIENDS" }));
    expect((await as(t, (ctx) => getApproval(ctx, before.id))).approval.status).toBe("invalidated");
    await expect(
      as(t, (ctx) => decide(ctx, before.id, { decision: "approve", payloadHash: before.payloadHash })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const ap = await approveAndPublish(t, item.id);
    expect((ap.summary as { sideEffects: string[] }).sideEffects.join(" ")).toMatch(
      /nothing will be posted to TikTok/,
    );
    expect((await as(t, (ctx) => contentDetail(ctx, item.id))).item.status).toBe("publishing");
    await advance();
    const d = await as(t, (ctx) => contentDetail(ctx, item.id));
    expect(d.item.status).toBe("published");
    expect(d.item.publishedMediaId).toMatch(/^mock_tt_pub_/);
    expect(publishes).toBe(1); // resumed with the stored publish ID, not re-posted
  });

  it("an ambiguous outcome on a channel without lookup is left for a human, never retried", async () => {
    const t = await makeTenant();
    const tt = await as(t, (ctx) => connectMockAccount(ctx, "tiktok"));
    const v = await as(t, (ctx) => uploadMedia(ctx, { name: "v.mp4", type: "video/mp4", data: mp4() }));
    const mock = new MockTikTokAdapter(tt.externalId);
    setPublisherOverrideForTests((a) =>
      a.provider === "tiktok"
        ? Object.assign(Object.create(mock), {
            publish: async () => {
              throw new ProviderError("unknown_outcome", "tiktok", "socket hang up");
            },
          })
        : null,
    );
    const item = await as(t, (ctx) =>
      createContent(ctx, {
        title: "TT",
        format: "reel",
        connectedAccountId: tt.id,
        version: { caption: "x", mediaAssetIds: [v.id] },
      }),
    );
    await approveAndPublish(t, item.id);
    await advance();
    const d = await as(t, (ctx) => contentDetail(ctx, item.id));
    expect(d.actions[0]).toMatchObject({ status: "unknown", attempts: 1 });
  });

  it("copy to channel creates a separate draft with a compatible format and its own approval", async () => {
    const t = await makeTenant();
    const ig = await as(t, (ctx) => connectMockAccount(ctx, "instagram"));
    const th = await as(t, (ctx) => connectMockAccount(ctx, "threads"));
    const a = await as(t, (ctx) => uploadMedia(ctx, { name: "a.jpg", type: "image/jpeg", data: jpeg() }));
    const story = await as(t, (ctx) =>
      createContent(ctx, {
        title: "Story",
        format: "story",
        connectedAccountId: ig.id,
        version: { caption: "Weekend sale", hashtags: ["sale"], mediaAssetIds: [a.id] },
      }),
    );
    const copy = await as(t, (ctx) => duplicateContent(ctx, story.id, th.id));
    expect(copy).toMatchObject({ format: "post", connectedAccountId: th.id, status: "draft" });
    const d = await as(t, (ctx) => contentDetail(ctx, copy.id));
    expect(d.current).toMatchObject({ caption: "Weekend sale", hashtags: ["sale"], mediaAssetIds: [a.id] });
    await approveAndPublish(t, copy.id);
    await advance();
    expect((await as(t, (ctx) => contentDetail(ctx, copy.id))).item.status).toBe("published");
    expect((await as(t, (ctx) => contentDetail(ctx, story.id))).item.status).toBe("draft");
  });
});

describe("Facebook Page comment-to-DM", () => {
  it("Page comments flow through the same pipeline: grounded drafts, separate approvals, Messenger private reply", async () => {
    const t = await makeTenant("FB Shop");
    const page = await as(t, (ctx) => connectMockAccount(ctx, "facebook"));
    await as(t, (ctx) => addAllowedDomain(ctx, "shop.example.com"));
    const product = await withTenant(t.workspaceId, (tx) =>
      tx
        .insert(s.products)
        .values({
          workspaceId: t.workspaceId,
          name: "Aurora Candle",
          url: "https://shop.example.com/aurora",
          priceMinor: 2500,
          currency: "USD",
          stockStatus: "in_stock",
          keywords: ["candle"],
        })
        .returning(),
    ).then((r) => r[0]!);
    const postId = `${page.externalId}_${randomUUID().slice(0, 8)}`;
    await withTenant(t.workspaceId, (tx) =>
      tx.insert(s.contentItems).values({
        workspaceId: t.workspaceId,
        title: "Candle post",
        format: "post",
        status: "published",
        productIds: [product.id],
        publishedMediaId: postId,
        connectedAccountId: page.id,
        publishMode: "mock",
      }),
    );
    const commentId = `${postId}_c1`;
    const { events } = normalizeMetaWebhook({
      object: "page",
      entry: [
        {
          id: page.externalId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: commentId,
                post_id: postId,
                message: "Please send me the link",
                from: { id: "fb_user_1", name: "Jo Doe" },
                created_time: Math.floor(Date.now() / 1000),
              },
            },
          ],
        },
      ],
    });
    // A live-mode delivery for a mock Page is ignored (mode isolation), the mock delivery is queued.
    expect((await withSystem((tx) => ingestWebhookEvents(tx, "live", events, "corr")))[0]!.status).toBe(
      "ignored_unknown_account",
    );
    expect((await withSystem((tx) => ingestWebhookEvents(tx, "mock", events, "corr")))[0]!.status).toBe(
      "queued",
    );
    await drain();
    const conv = (
      await withTenant(t.workspaceId, (tx) =>
        tx.select().from(s.inboxConversations).where(eq(s.inboxConversations.externalThreadId, commentId)),
      )
    )[0]!;
    expect(conv.channel).toBe("facebook_comment");
    const d = await as(t, (ctx) => conversationDetail(ctx, conv.id));
    expect(d.product?.name).toBe("Aurora Candle");
    expect(d.contact?.username).toBe("Jo Doe");
    const priv = d.drafts.find((x) => x.actionType === "private_comment_reply")!;
    expect(priv.text).toContain("https://shop.example.com/aurora");
    const pa = (await as(t, (ctx) => getApproval(ctx, priv.approvalRequestId!))).approval;
    expect(pa.summary).toMatchObject({ channel: "Messenger (private)" });
    await as(t, (ctx) => decide(ctx, pa.id, { decision: "approve", payloadHash: pa.payloadHash }));
    await drain();
    const after = await as(t, (ctx) => conversationDetail(ctx, conv.id));
    expect(after.drafts.find((x) => x.id === priv.id)?.status).toBe("sent");
    const action = (
      await withTenant(t.workspaceId, (tx) =>
        tx
          .select()
          .from(s.externalActions)
          .where(
            and(eq(s.externalActions.subjectId, priv.id), eq(s.externalActions.workspaceId, t.workspaceId)),
          ),
      )
    )[0]!;
    expect(action).toMatchObject({ provider: "facebook", status: "succeeded", mode: "mock" });
  });
});

describe("channel OAuth", () => {
  it("X OAuth stores an encrypted PKCE verifier bound to the state; missing credentials fail clearly", async () => {
    const t = await makeTenant();
    await expect(as(t, (ctx) => startOAuth(ctx, "x"))).rejects.toMatchObject({
      code: "INTEGRATION_NOT_CONNECTED",
      message: expect.stringContaining("X_CLIENT_ID"),
    });
    process.env.X_CLIENT_ID = "cid";
    process.env.X_CLIENT_SECRET = "secret";
    resetEnvCache();
    try {
      const { url } = await as(t, (ctx) => startOAuth(ctx, "x"));
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const row = (
        await withSystem((tx) =>
          tx
            .select()
            .from(s.oauthStates)
            .where(eq(s.oauthStates.id, sha256(state))),
        )
      )[0]!;
      expect(row.encryptedCodeVerifier).toBeTruthy();
      expect(row.encryptedCodeVerifier).not.toContain(u.searchParams.get("code_challenge")!);
      expect(pkceChallenge(decryptSecret(row.encryptedCodeVerifier!))).toBe(
        u.searchParams.get("code_challenge"),
      );
      const st = await consumeOAuthState(state, "x", t.userId);
      expect(pkceChallenge(st.codeVerifier!)).toBe(u.searchParams.get("code_challenge"));
      // Single use.
      await expect(consumeOAuthState(state, "x", t.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      delete process.env.X_CLIENT_ID;
      delete process.env.X_CLIENT_SECRET;
      resetEnvCache();
    }
  });

  it("Facebook shares the Meta app; Threads, X and TikTok report not configured without their own credentials", async () => {
    const t = await makeTenant();
    const r = await as(t, (ctx) => listIntegrations(ctx));
    expect(r.providers.facebook.configured).toBe(true); // META_APP_ID/SECRET are set in the test env
    for (const p of ["threads", "x", "tiktok"] as const) expect(r.providers[p].configured).toBe(false);
  });
});
