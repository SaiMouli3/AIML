import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { as, drain, makeTenant, type Tenant } from "../helpers";
import { withSystem, withTenant } from "@/server/db/tenant";
import * as s from "@/server/db/schema";
import { connectMockAccount, updateAccountSettings } from "@/server/services/integrations";
import { addAllowedDomain, upsertProduct } from "@/server/services/company-brain";
import {
  conversationDetail,
  editDraft,
  ingestWebhookEvents,
  inboxMetrics,
  listConversations,
  normalizeMetaWebhook,
  setHumanTakeover,
} from "@/server/services/inbox";
import { decide, getApproval } from "@/server/services/approvals";
import { createRule, setRuleEnabled, testRule } from "@/server/services/automations";
import { setAutomationPaused } from "@/server/services/workspace";

async function setup(opts: { domain?: boolean; productUrl?: string } = {}) {
  const t = await makeTenant("Shop");
  const acct = await as(t, (ctx) => connectMockAccount(ctx, "instagram"));
  if (opts.domain !== false) await as(t, (ctx) => addAllowedDomain(ctx, "shop.example.com"));
  const product = await withTenant(t.workspaceId, (tx) =>
    tx
      .insert(s.products)
      .values({
        workspaceId: t.workspaceId,
        name: "Aurora Candle",
        url: opts.productUrl ?? "https://shop.example.com/aurora",
        priceMinor: 2500,
        currency: "USD",
        stockStatus: "in_stock",
        variants: ["Small", "Large"],
        keywords: ["candle"],
      })
      .returning(),
  ).then((r) => r[0]!);
  // A published reel featuring that product.
  const mediaId = `mock_media_${randomUUID()}`;
  await withTenant(t.workspaceId, (tx) =>
    tx.insert(s.contentItems).values({
      workspaceId: t.workspaceId,
      title: "Candle reel",
      format: "reel",
      status: "published",
      productIds: [product.id],
      publishedMediaId: mediaId,
      connectedAccountId: acct.id,
      publishMode: "mock",
    }),
  );
  return { t, acct, product, mediaId };
}

async function comment(
  acctExternalId: string,
  mediaId: string,
  text: string,
  opts: { commentId?: string; time?: number; from?: string } = {},
) {
  const commentId = opts.commentId ?? `c_${randomUUID()}`;
  const payload = {
    object: "instagram",
    entry: [
      {
        id: acctExternalId,
        time: opts.time ?? Math.floor(Date.now() / 1000),
        field: "comments",
        value: {
          id: commentId,
          text,
          from: { id: opts.from ?? `u_${randomUUID().slice(0, 8)}`, username: "jo" },
          media: { id: mediaId, media_product_type: "REELS" },
        },
      },
    ],
  };
  const { events } = normalizeMetaWebhook(payload);
  const r = await withSystem((tx) => ingestWebhookEvents(tx, "mock", events, "corr_test"));
  await drain();
  return { commentId, result: r };
}

async function conv(t: Tenant, commentId: string) {
  const rows = await withTenant(t.workspaceId, (tx) =>
    tx.select().from(s.inboxConversations).where(eq(s.inboxConversations.externalThreadId, commentId)),
  );
  return as(t, (ctx) => conversationDetail(ctx, rows[0]!.id));
}

describe("comment-to-DM sales assistant", () => {
  it("drafts separate public and private replies that require separate approvals", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "Please send me the link");
    const d = await conv(t, commentId);
    expect(d.conversation.intent).toBe("product_link");
    expect(d.conversation.isLead).toBe(true);
    expect(d.product?.name).toBe("Aurora Candle");
    const pub = d.drafts.find((x) => x.actionType === "public_comment_reply")!;
    const priv = d.drafts.find((x) => x.actionType === "private_comment_reply")!;
    expect(priv.text).toContain("https://shop.example.com/aurora");
    expect(pub.text).not.toMatch(/https?:\/\//);
    expect(pub.status).toBe("pending_approval");
    expect(priv.status).toBe("pending_approval");
    expect(pub.approvalRequestId).not.toBe(priv.approvalRequestId);
    // Approving the public reply does not send the private one.
    const pa = (await as(t, (ctx) => getApproval(ctx, pub.approvalRequestId!))).approval;
    await as(t, (ctx) => decide(ctx, pa.id, { decision: "approve", payloadHash: pa.payloadHash }));
    await drain();
    let after = await conv(t, commentId);
    expect(after.drafts.find((x) => x.id === pub.id)?.status).toBe("sent");
    expect(after.drafts.find((x) => x.id === priv.id)?.status).toBe("pending_approval");
    const pr = (await as(t, (ctx) => getApproval(ctx, priv.approvalRequestId!))).approval;
    await as(t, (ctx) => decide(ctx, pr.id, { decision: "approve", payloadHash: pr.payloadHash }));
    await drain();
    after = await conv(t, commentId);
    expect(after.drafts.every((x) => x.status === "sent")).toBe(true);
    expect(after.messages.filter((m) => m.direction === "outbound").every((m) => m.mode === "mock")).toBe(
      true,
    );
    const m = await as(t, (ctx) => inboxMetrics(ctx));
    expect(m).toMatchObject({ sent: 2, sentPrivate: 1 });
    expect(m.notTracked).toContain("Link clicks");
  });

  it("duplicate webhook deliveries are processed once", async () => {
    const { t, acct, mediaId } = await setup();
    const commentId = `c_${randomUUID()}`;
    const first = await comment(acct.externalId, mediaId, "LINK", { commentId });
    const second = await comment(acct.externalId, mediaId, "LINK", { commentId });
    expect(first.result[0]?.status).toBe("queued");
    expect(second.result[0]?.status).toBe("duplicate");
    const d = await conv(t, commentId);
    expect(d.messages.filter((x) => x.direction === "inbound")).toHaveLength(1);
    expect(d.drafts).toHaveLength(2);
  });

  it("escalates ambiguous products instead of guessing", async () => {
    const { t, acct, product } = await setup();
    const second = await as(t, (ctx) =>
      upsertProduct(ctx, {
        name: "Nimbus Mug",
        url: "https://shop.example.com/nimbus",
        priceMinor: 1800,
        currency: "USD",
        keywords: ["mug"],
      }),
    );
    const mediaId = `m_${randomUUID()}`;
    await withTenant(t.workspaceId, (tx) =>
      tx.insert(s.contentItems).values({
        workspaceId: t.workspaceId,
        title: "Bundle",
        format: "post",
        status: "published",
        productIds: [product.id, second.id],
        publishedMediaId: mediaId,
        connectedAccountId: acct.id,
      }),
    );
    const { commentId } = await comment(acct.externalId, mediaId, "link please");
    const d = await conv(t, commentId);
    expect(d.conversation.status).toBe("needs_human");
    expect(d.conversation.escalationReasons.join()).toMatch(/ambiguous/i);
    expect(d.drafts).toHaveLength(0);
  });

  it("never sends unapproved URLs: product URL off the allowlist escalates", async () => {
    const { t, acct, mediaId } = await setup({ productUrl: "https://untrusted-shop.example.net/aurora" });
    await withTenant(t.workspaceId, (tx) =>
      tx.delete(s.allowedDomains).where(eq(s.allowedDomains.domain, "untrusted-shop.example.net")),
    );
    const { commentId } = await comment(acct.externalId, mediaId, "send link");
    const d = await conv(t, commentId);
    expect(d.conversation.status).toBe("needs_human");
    expect(d.conversation.escalationReasons.join()).toMatch(/URL blocked/);
  });

  it("complaints and refunds always go to a human; spam is ignored", async () => {
    const { t, acct, mediaId } = await setup();
    const c1 = await comment(acct.externalId, mediaId, "My order never arrived, I want a refund");
    expect((await conv(t, c1.commentId)).conversation.status).toBe("needs_human");
    const c2 = await comment(acct.externalId, mediaId, "follow me for free followers https://spam.biz");
    expect((await conv(t, c2.commentId)).conversation.status).toBe("ignored");
  });

  it("blocks private replies when permissions are missing", async () => {
    const { t, acct, mediaId } = await setup();
    await withTenant(t.workspaceId, (tx) =>
      tx
        .update(s.providerCapabilities)
        .set({ status: "unavailable", reason: "Missing instagram_business_manage_comments" })
        .where(
          and(
            eq(s.providerCapabilities.accountId, acct.id),
            eq(s.providerCapabilities.capability, "private_reply"),
          ),
        ),
    );
    const { commentId } = await comment(acct.externalId, mediaId, "LINK");
    const d = await conv(t, commentId);
    const priv = d.drafts.find((x) => x.actionType === "private_comment_reply")!;
    expect(priv.status).toBe("blocked");
    expect(priv.blockedReasons.join()).toMatch(/instagram_business_manage_comments/);
  });

  it("re-checks the 7-day window at send time (expired eligibility)", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "LINK");
    const d = await conv(t, commentId);
    // Simulate approval landing after the window closed.
    await withTenant(t.workspaceId, (tx) =>
      tx
        .update(s.inboxMessages)
        .set({ providerCreatedAt: new Date(Date.now() - 8 * 86400_000) })
        .where(eq(s.inboxMessages.conversationId, d.conversation.id)),
    );
    const priv = d.drafts.find((x) => x.actionType === "private_comment_reply")!;
    const ap = (await as(t, (ctx) => getApproval(ctx, priv.approvalRequestId!))).approval;
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    const after = await conv(t, commentId);
    const p2 = after.drafts.find((x) => x.id === priv.id)!;
    expect(p2.status).toBe("failed");
    expect(p2.blockedReasons.join()).toMatch(/7 days/);
  });

  it("editing a draft invalidates its approval", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "LINK");
    const priv = (await conv(t, commentId)).drafts.find((x) => x.actionType === "private_comment_reply")!;
    await as(t, (ctx) => editDraft(ctx, priv.id, "Hi! Here it is: https://shop.example.com/aurora"));
    expect((await as(t, (ctx) => getApproval(ctx, priv.approvalRequestId!))).approval.status).toBe(
      "invalidated",
    );
    await expect(
      as(t, (ctx) => editDraft(ctx, priv.id, "Only $9 today! https://shop.example.com/aurora")),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("human takeover discards pending drafts and disables automation for the conversation", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "LINK");
    const d = await conv(t, commentId);
    await as(t, (ctx) => setHumanTakeover(ctx, d.conversation.id, true));
    const after = await conv(t, commentId);
    expect(after.conversation.humanTakeover).toBe(true);
    expect(after.drafts.every((x) => x.status === "discarded")).toBe(true);
    const tabs = await as(t, (ctx) => listConversations(ctx, { tab: "automation_paused" }));
    expect(tabs.some((c) => c.id === d.conversation.id)).toBe(true);
  });

  it("bounded auto-reply: tested, human-enabled rule sends; rate limits and the emergency pause stop it", async () => {
    const { t, acct, mediaId, product } = await setup();
    const rule = await as(t, (ctx) =>
      createRule(ctx, {
        kind: "comment_to_dm",
        name: "LINK auto-reply",
        approvalMode: "bounded_auto",
        accountId: acct.id,
        config: {
          triggers: ["LINK"],
          allowedIntents: ["product_link"],
          productIds: [product.id],
          sendPublicReply: false,
          sendPrivateReply: true,
          limits: { maxPerHour: 1, maxPerDay: 10, perUserCooldownHours: 24 },
        },
      }),
    );
    await expect(as(t, (ctx) => setRuleEnabled(ctx, rule.id, true))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const test = await as(t, (ctx) =>
      testRule(ctx, rule.id, { samples: ["LINK", "refund now"], linkedProductIds: [product.id] }),
    );
    expect((test as { results: Array<{ decision: string }> }).results.map((r) => r.decision)).toEqual([
      "auto_send",
      "no_match",
    ]);
    await expect(
      as(t, (ctx) => setRuleEnabled(ctx, rule.id, true), { actorType: "agent" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as(t, (ctx) => setRuleEnabled(ctx, rule.id, true));

    const c1 = await comment(acct.externalId, mediaId, "LINK");
    const d1 = await conv(t, c1.commentId);
    expect(d1.drafts[0]).toMatchObject({
      actionType: "private_comment_reply",
      status: "sent",
      automationRuleId: rule.id,
    });

    // Rate limit: maxPerHour = 1 → the next auto-send is blocked, not sent.
    const c2 = await comment(acct.externalId, mediaId, "LINK");
    const d2 = await conv(t, c2.commentId);
    expect(d2.drafts[0]?.status).toBe("failed");
    expect(d2.drafts[0]?.blockedReasons.join()).toMatch(/rate limit/i);

    // Emergency pause: no automated sends at all.
    await as(t, (ctx) => setAutomationPaused(ctx, true));
    const c3 = await comment(acct.externalId, mediaId, "LINK");
    const d3 = await conv(t, c3.commentId);
    expect(d3.drafts[0]?.status).not.toBe("sent");
    expect(d3.drafts[0]?.blockedReasons.join()).toMatch(/paused/i);
    await as(t, (ctx) => setAutomationPaused(ctx, false));

    // Per-account pause.
    await as(t, (ctx) => updateAccountSettings(ctx, acct.id, { automationPaused: true }));
    const c4 = await comment(acct.externalId, mediaId, "LINK");
    expect((await conv(t, c4.commentId)).drafts[0]?.status).not.toBe("sent");
  });

  it("a private reply is sent at most once per comment", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "LINK");
    const priv = (await conv(t, commentId)).drafts.find((x) => x.actionType === "private_comment_reply")!;
    const ap = (await as(t, (ctx) => getApproval(ctx, priv.approvalRequestId!))).approval;
    await as(t, (ctx) => decide(ctx, ap.id, { decision: "approve", payloadHash: ap.payloadHash }));
    await drain();
    // Replay the send job: idempotency key is per comment, so nothing new is sent.
    await withTenant(t.workspaceId, (tx) =>
      tx.insert(s.jobs).values({
        type: "inbox.send_reply",
        workspaceId: t.workspaceId,
        payload: { draftId: priv.id, approvalId: ap.id },
      }),
    );
    await drain();
    const sent = await withTenant(t.workspaceId, (tx) =>
      tx.select().from(s.externalActions).where(eq(s.externalActions.subjectId, priv.id)),
    );
    expect(sent).toHaveLength(1);
    const msgs = (await conv(t, commentId)).messages.filter((m) => m.kind === "private_reply");
    expect(msgs).toHaveLength(1);
  });

  it("a comment alone does not open a DM conversation; inbound DMs open a 24h window", async () => {
    const { t, acct } = await setup();
    const igsid = `u_${randomUUID().slice(0, 8)}`;
    const payload = {
      object: "instagram",
      entry: [
        {
          id: acct.externalId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: igsid },
              recipient: { id: acct.externalId },
              timestamp: Date.now() - 25 * 3600_000,
              message: { mid: `mid_${randomUUID()}`, text: "price of the candle?" },
            },
          ],
        },
      ],
    };
    await withSystem((tx) => ingestWebhookEvents(tx, "mock", normalizeMetaWebhook(payload).events, "corr"));
    await drain();
    const rows = await withTenant(t.workspaceId, (tx) =>
      tx.select().from(s.inboxConversations).where(eq(s.inboxConversations.externalThreadId, igsid)),
    );
    const d = await as(t, (ctx) => conversationDetail(ctx, rows[0]!.id));
    const dm = d.drafts.find((x) => x.actionType === "dm_reply");
    expect(dm?.status).toBe("blocked");
    expect(dm?.blockedReasons.join()).toMatch(/24 hours/);
  });

  it("logs every stage, including ignored and blocked events", async () => {
    const { t, acct, mediaId } = await setup();
    const { commentId } = await comment(acct.externalId, mediaId, "Price?");
    const d = await conv(t, commentId);
    const actions = d.history.map((h) => h.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "inbox.received",
        "inbox.classified",
        "inbox.drafted",
        "inbox.approval_requested",
      ]),
    );
    const unknown = await withSystem((tx) =>
      ingestWebhookEvents(
        tx,
        "mock",
        normalizeMetaWebhook({
          object: "instagram",
          entry: [
            {
              id: "not-connected",
              field: "comments",
              value: { id: `c_${randomUUID()}`, text: "x", from: { id: "u" } },
            },
          ],
        }).events,
        "c",
      ),
    );
    expect(unknown[0]?.status).toBe("ignored_unknown_account");
  });
});
