import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { classifyIntentRules, type Intent } from "../agents/contracts";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import * as s from "../db/schema";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { hashPayload } from "../lib/crypto";
import { detectInjection } from "../lib/injection";
import { consumeRateLimit, peekRateLimit } from "../lib/rate-limit";
import { checkUrl, extractUrls, findUnsafeUrls } from "../lib/url-safety";
import { evaluateAction, type ActionType, type BoundedPolicy } from "../policy/policy";
import { enqueue } from "../queue/queue";
import { registerJob, type JobContext } from "../queue/runtime";
import { invalidateApprovalsForSubject, loadApprovalForExecution, markApprovalExecuted, registerApprovalSubject, requestApproval } from "./approvals";
import { commentToDmConfigSchema, renderTemplate, triggerMatches, withinSchedule, type CommentToDmConfig } from "./automation-config";
import { listAllowedDomains, listProducts } from "./company-brain";
import { runExternalAction } from "./external-actions";
import { capabilityStatus, getAccount, instagramAdapter, type AccountRow } from "./integrations";
import { notify } from "./notifications";
import { offerSentence } from "./promotions";

/**
 * Instagram comment-to-DM sales assistant and unified inbox.
 *
 * Platform rules applied (Meta docs, verified Oct 2026):
 *  - Private reply: one message per comment, within 7 days of the comment (Live: only during broadcast).
 *  - Follow-up DMs only after the person replies, within 24 hours of their latest message.
 *  - Public replies, private replies and DM replies are distinct action types with separate approvals.
 */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600_000;
export const DM_WINDOW_MS = 24 * 3600_000;
const ACCOUNT_HOURLY_SEND_LIMIT = 200;

type Product = Awaited<ReturnType<typeof listProducts>>[number];
type Conversation = typeof s.inboxConversations.$inferSelect;
type Draft = typeof s.replyDrafts.$inferSelect;
type Promo = typeof s.promotionOffers.$inferSelect;

// ───────────────────────────── Webhook normalization ─────────────────────────────

export interface NormalizedEvent {
  kind: "comment" | "dm";
  eventKey: string;
  igAccountId: string;
  commentId?: string;
  mediaId?: string;
  mediaProductType?: string;
  messageId?: string;
  fromId: string;
  fromUsername?: string;
  text: string;
  timestamp: Date;
  isEcho: boolean;
  parentCommentId?: string;
}

const commentValue = z.object({
  id: z.string().optional(),
  comment_id: z.string().optional(),
  text: z.string().default(""),
  from: z.object({ id: z.string(), username: z.string().optional() }),
  media: z.object({ id: z.string(), media_product_type: z.string().optional() }).optional(),
  parent_id: z.string().optional(),
});

const messagingItem = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z.object({ mid: z.string(), text: z.string().optional(), is_echo: z.boolean().optional() }).optional(),
});

/** Normalize both Instagram-Login (`field`/`value` on entry) and Facebook-Login (`changes[]`) payload shapes. */
export function normalizeMetaWebhook(payload: unknown): { events: NormalizedEvent[]; ignored: number } {
  const root = z.object({ object: z.string(), entry: z.array(z.record(z.string(), z.unknown())) }).safeParse(payload);
  if (!root.success) return { events: [], ignored: 1 };
  const events: NormalizedEvent[] = [];
  let ignored = 0;
  for (const entry of root.data.entry) {
    const igAccountId = String(entry.id ?? "");
    const time = typeof entry.time === "number" ? new Date(entry.time > 1e12 ? entry.time : entry.time * 1000) : new Date();
    const changes: Array<{ field?: unknown; value?: unknown }> = Array.isArray(entry.changes) ? (entry.changes as never) : entry.field ? [{ field: entry.field, value: entry.value }] : [];
    for (const ch of changes) {
      if (ch.field !== "comments" && ch.field !== "live_comments") {
        ignored++;
        continue;
      }
      const v = commentValue.safeParse(ch.value);
      const cid = v.success ? (v.data.id ?? v.data.comment_id) : undefined;
      if (!v.success || !cid) {
        ignored++;
        continue;
      }
      events.push({
        kind: "comment",
        eventKey: `comment:${cid}`,
        igAccountId,
        commentId: cid,
        mediaId: v.data.media?.id,
        mediaProductType: ch.field === "live_comments" ? "LIVE" : v.data.media?.media_product_type,
        fromId: v.data.from.id,
        fromUsername: v.data.from.username,
        text: v.data.text,
        timestamp: time,
        isEcho: v.data.from.id === igAccountId,
        parentCommentId: v.data.parent_id,
      });
    }
    for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const p = messagingItem.safeParse(m);
      if (!p.success || !p.data.message) {
        ignored++;
        continue;
      }
      events.push({
        kind: "dm",
        eventKey: `message:${p.data.message.mid}`,
        igAccountId,
        messageId: p.data.message.mid,
        fromId: p.data.sender.id,
        text: p.data.message.text ?? "",
        timestamp: new Date(p.data.timestamp),
        isEcho: Boolean(p.data.message.is_echo) || p.data.sender.id === igAccountId,
      });
    }
  }
  return { events, ignored };
}

// ───────────────────────────── Product resolution ─────────────────────────────

export interface ProductResolution {
  product: Product | null;
  confidence: number;
  reason: string;
  candidates: string[];
}

/**
 * Resolve the product a comment refers to. Order: products linked to the post/Reel, then explicit
 * name/keyword mentions. Multiple equally plausible products → ambiguous (null), never a guess.
 */
export function resolveProduct(text: string, linkedProductIds: string[], catalog: Product[]): ProductResolution {
  const t = text.toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t);
  const STOP = new Set(["the", "and", "for", "with", "set", "new", "kit", "pack"]);
  const mentions = (p: Product) =>
    t.includes(p.name.toLowerCase()) ||
    p.keywords.some((k) => k.length > 2 && word(k)) ||
    p.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((tok) => tok.length >= 3 && !STOP.has(tok) && word(tok));
  const linked = catalog.filter((p) => linkedProductIds.includes(p.id));
  if (linked.length === 1) return { product: linked[0]!, confidence: 0.95, reason: "Only product linked to this post", candidates: [linked[0]!.id] };
  if (linked.length > 1) {
    const hit = linked.filter(mentions);
    if (hit.length === 1) return { product: hit[0]!, confidence: 0.85, reason: "Named in comment among products linked to this post", candidates: linked.map((p) => p.id) };
    return { product: null, confidence: 0.3, reason: `Post features ${linked.length} products and the comment does not say which`, candidates: linked.map((p) => p.id) };
  }
  const hits = catalog.filter(mentions);
  if (hits.length === 1) return { product: hits[0]!, confidence: 0.75, reason: "Named in comment (post has no linked product)", candidates: [hits[0]!.id] };
  if (hits.length > 1) return { product: null, confidence: 0.3, reason: "Comment matches several catalog products", candidates: hits.map((p) => p.id) };
  return { product: null, confidence: 0, reason: "No product linked to this post or named in the comment", candidates: [] };
}

const fmtPrice = (p: Product) => (p.priceMinor !== null && p.currency ? new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency }).format(p.priceMinor / 100) : null);

// ───────────────────────────── Drafting & escalation ─────────────────────────────

export interface DraftPlan {
  escalate: boolean;
  escalationReasons: string[];
  publicReply: string | null;
  privateReply: string | null;
  url: string | null;
  sourceFactIds: string[];
}

const NEEDS_PRODUCT: Intent[] = ["product_link", "price", "stock_variant", "purchase_intent"];

export function planReplies(input: {
  intent: Intent;
  confidence: number;
  username?: string;
  resolution: ProductResolution;
  promotion: Promo | null;
  rule: CommentToDmConfig | null;
  minConfidence: number;
  injectionFlag: boolean;
  allowedDomains: string[];
  llmPrivateReply?: string | null;
}): DraftPlan {
  const reasons: string[] = [];
  const p = input.resolution.product;
  if (input.intent === "complaint") reasons.push("Complaint, refund or legal issue: human handling required");
  if (input.intent === "support") reasons.push("Order/support request: human handling required");
  if (input.intent === "unknown") reasons.push("Intent unclear");
  if (input.confidence < input.minConfidence) reasons.push(`Classification confidence ${input.confidence.toFixed(2)} is below ${input.minConfidence}`);
  if (NEEDS_PRODUCT.includes(input.intent) && !p) reasons.push(`Product is ambiguous: ${input.resolution.reason}`);
  if (input.intent === "price" && p && !fmtPrice(p)) reasons.push("No approved price in the catalog");
  if (input.intent === "stock_variant" && p && p.stockStatus === "unknown") reasons.push("Stock status is unknown");
  if (input.intent === "delivery" && !(p?.deliveryPolicy)) reasons.push("No approved delivery policy for this product");
  if (input.intent === "offer" && !input.promotion) reasons.push("No active approved promotion to describe");
  if (input.injectionFlag && input.intent === "unknown") reasons.push("Message contains instruction-like text");
  if (input.intent === "product_link" && p && !p.url) reasons.push("Product has no approved URL");
  if (p?.url) {
    const chk = checkUrl(p.url, input.allowedDomains);
    if (!chk.ok) reasons.push(`Product URL blocked: ${chk.reason}`);
  }
  if (reasons.length || input.intent === "spam") return { escalate: input.intent !== "spam", escalationReasons: reasons, publicReply: null, privateReply: null, url: null, sourceFactIds: [] };

  const values = {
    username: input.username ?? "there",
    product_name: p?.name ?? null,
    product_url: p?.url ?? null,
    price: p ? fmtPrice(p) : null,
    variants: p?.variants.length ? p.variants.join(", ") : null,
    stock: p ? { in_stock: "in stock", low: "low in stock", out_of_stock: "currently out of stock", unknown: null }[p.stockStatus] ?? null : null,
    delivery: p?.deliveryPolicy ?? null,
    offer: input.promotion ? offerSentence(input.promotion) : null,
    offer_end: input.promotion?.endsAt
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: input.promotion.timezone ?? "UTC" }).format(input.promotion.endsAt) + ` (${input.promotion.timezone ?? "UTC"})`
      : null,
  };
  const defaults: Record<Intent, string> = {
    product_link: "Hi @{username}! Here's the link to {product_name}: {product_url}",
    purchase_intent: "Hi @{username}! You can get {product_name} here: {product_url}",
    price: "Hi @{username}! {product_name} is {price}. Details: {product_url}",
    stock_variant: "Hi @{username}! {product_name} is {stock}. Options: {variants}. {product_url}",
    delivery: "Hi @{username}! Delivery for {product_name}: {delivery}",
    offer: "Hi @{username}! Current offer: {offer}, ends {offer_end}. {product_url}",
    support: "",
    complaint: "",
    spam: "",
    unknown: "",
  };
  const privTemplate = input.rule?.privateReplyTemplate ?? defaults[input.intent];
  const priv = renderTemplate(privTemplate, values);
  const pub = renderTemplate(input.rule?.publicReplyTemplate ?? "Thanks @{username}! We've sent you the details in a private message.", values);
  if (priv.missing.length) {
    return { escalate: true, escalationReasons: [`Approved data missing for: ${priv.missing.join(", ")}`], publicReply: null, privateReply: null, url: null, sourceFactIds: [] };
  }
  // An LLM-written private reply may replace the template only if it passes every data check.
  let privateText = priv.text;
  if (input.llmPrivateReply && validateGroundedText(input.llmPrivateReply, p, input.allowedDomains).ok) privateText = input.llmPrivateReply;
  return { escalate: false, escalationReasons: [], publicReply: pub.text || null, privateReply: privateText, url: p?.url ?? null, sourceFactIds: [] };
}

/** Grounding check for any reply text: only approved URLs and catalog prices may appear. */
export function validateGroundedText(text: string, product: Product | null, allowedDomains: string[]) {
  const problems: string[] = [];
  for (const u of findUnsafeUrls(text, allowedDomains)) problems.push(`${u.url}: ${u.reason}`);
  for (const u of extractUrls(text)) if (product?.url && new URL(u).hostname !== new URL(product.url).hostname) problems.push(`Link ${u} is not the product URL`);
  const prices = [...text.matchAll(/[$€£₹]\s?(\d+(?:[.,]\d{1,2})?)/g)].map((m) => Number(m[1]!.replace(",", ".")));
  const real = product?.priceMinor !== null && product?.priceMinor !== undefined ? product.priceMinor / 100 : null;
  for (const pr of prices) if (real === null || Math.abs(pr - real) > 0.001) problems.push(`Price ${pr} does not match the catalog`);
  if (detectInjection(text).flagged) problems.push("Contains instruction-like text");
  return { ok: problems.length === 0, problems };
}

// ───────────────────────────── Eligibility ─────────────────────────────

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
  windowEndsAt?: string | null;
}

export async function privateReplyEligibility(ctx: Ctx, conv: Conversation, account: AccountRow, opts: { now?: Date } = {}): Promise<Eligibility> {
  const now = opts.now ?? new Date();
  const reasons: string[] = [];
  const cap = await capabilityStatus(ctx, account.id, "private_reply");
  if (cap.status !== "available") reasons.push(`Private replies unavailable: ${cap.reason ?? "missing permission"}`);
  if (account.status !== "connected") reasons.push(`Account is ${account.status}`);
  if (account.settings.privateReplies === false) reasons.push("Private replies are disabled for this account");
  const commentMsg = (await ctx.tx.select().from(s.inboxMessages).where(and(eq(s.inboxMessages.conversationId, conv.id), eq(s.inboxMessages.kind, "comment"))).orderBy(s.inboxMessages.createdAt).limit(1))[0];
  const commentAt = commentMsg?.providerCreatedAt ?? conv.createdAt;
  const windowEnds = new Date(commentAt.getTime() + PRIVATE_REPLY_WINDOW_MS);
  if (conv.mediaProductType === "LIVE") reasons.push("Live comments can only receive private replies during the broadcast; verify the broadcast is live");
  if (now > windowEnds) reasons.push("More than 7 days since the comment: private reply window has expired");
  const prior = await ctx.tx
    .select({ id: s.externalActions.id, status: s.externalActions.status })
    .from(s.externalActions)
    .where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), eq(s.externalActions.idempotencyKey, `private_reply:${account.id}:${conv.externalThreadId}`)))
    .limit(1);
  if (prior[0] && ["succeeded", "unknown", "executing"].includes(prior[0].status)) reasons.push("A private reply was already sent (or may have been sent) for this comment; only one is allowed");
  if (conv.contactId) {
    const c = (await ctx.tx.select().from(s.contactRecords).where(eq(s.contactRecords.id, conv.contactId)).limit(1))[0];
    if (c?.optedOut) reasons.push("Recipient opted out");
    if (c?.suppressed) reasons.push("Recipient is on the suppression list");
  }
  if (conv.humanTakeover) reasons.push("A human has taken over this conversation");
  const rl = await peekRateLimit(ctx.tx, `send:${account.id}:hour`, ACCOUNT_HOURLY_SEND_LIMIT, 3600);
  if (!rl.allowed) reasons.push("Account hourly send limit reached");
  return { eligible: reasons.length === 0, reasons, windowEndsAt: windowEnds.toISOString() };
}

export async function publicReplyEligibility(ctx: Ctx, conv: Conversation, account: AccountRow): Promise<Eligibility> {
  const reasons: string[] = [];
  const cap = await capabilityStatus(ctx, account.id, "comments_reply");
  if (cap.status !== "available") reasons.push(`Comment replies unavailable: ${cap.reason ?? "missing permission"}`);
  if (account.status !== "connected") reasons.push(`Account is ${account.status}`);
  if (account.settings.publicReplySuggestions === false) reasons.push("Public replies are disabled for this account");
  if (conv.humanTakeover) reasons.push("A human has taken over this conversation");
  return { eligible: reasons.length === 0, reasons };
}

/** DM replies are allowed only within 24 hours of the person's latest inbound message. */
export async function dmEligibility(ctx: Ctx, conv: Conversation, account: AccountRow, now = new Date()): Promise<Eligibility> {
  const reasons: string[] = [];
  const cap = await capabilityStatus(ctx, account.id, "messaging");
  if (cap.status === "unavailable") reasons.push(`Messaging unavailable: ${cap.reason ?? "missing permission"}`);
  if (account.status !== "connected") reasons.push(`Account is ${account.status}`);
  const lastInbound = (await ctx.tx
    .select()
    .from(s.inboxMessages)
    .where(and(eq(s.inboxMessages.conversationId, conv.id), eq(s.inboxMessages.direction, "inbound"), eq(s.inboxMessages.kind, "dm")))
    .orderBy(desc(s.inboxMessages.providerCreatedAt))
    .limit(1))[0];
  if (!lastInbound) reasons.push("The person has not messaged the account; a comment alone does not open a DM conversation");
  const windowEnds = lastInbound?.providerCreatedAt ? new Date(lastInbound.providerCreatedAt.getTime() + DM_WINDOW_MS) : null;
  if (windowEnds && now > windowEnds) reasons.push("More than 24 hours since the person's last message: messaging window closed");
  if (conv.contactId) {
    const c = (await ctx.tx.select().from(s.contactRecords).where(eq(s.contactRecords.id, conv.contactId)).limit(1))[0];
    if (c?.optedOut) reasons.push("Recipient opted out");
  }
  if (conv.humanTakeover) reasons.push("A human has taken over this conversation");
  return { eligible: reasons.length === 0, reasons, windowEndsAt: windowEnds?.toISOString() ?? null };
}

// ───────────────────────────── Ingestion ─────────────────────────────

/** Persist a webhook delivery durably and enqueue processing. Duplicate deliveries are acknowledged and ignored. */
export async function ingestWebhookEvents(
  tx: Parameters<Parameters<typeof import("../db/tenant").withSystem>[0]>[0],
  provider: "instagram" | "mock_instagram",
  events: NormalizedEvent[],
  correlationId: string,
) {
  const results: Array<{ eventKey: string; status: string }> = [];
  for (const ev of events) {
    const inserted = await tx
      .insert(s.webhookEvents)
      .values({ provider, eventKey: ev.eventKey, field: ev.kind, payload: { ...ev, timestamp: ev.timestamp.toISOString() } })
      .onConflictDoUpdate({ target: [s.webhookEvents.provider, s.webhookEvents.eventKey], set: { deliveries: sql`${s.webhookEvents.deliveries} + 1` } })
      .returning({ id: s.webhookEvents.id, deliveries: s.webhookEvents.deliveries });
    if ((inserted[0]?.deliveries ?? 1) > 1) {
      results.push({ eventKey: ev.eventKey, status: "duplicate" });
      continue;
    }
    if (ev.isEcho) {
      await tx.update(s.webhookEvents).set({ status: "ignored", statusReason: "Echo of our own message/reply", processedAt: new Date() }).where(eq(s.webhookEvents.id, inserted[0]!.id));
      results.push({ eventKey: ev.eventKey, status: "ignored_echo" });
      continue;
    }
    const accounts = await tx
      .select()
      .from(s.connectedAccounts)
      .where(and(eq(s.connectedAccounts.provider, "instagram"), eq(s.connectedAccounts.externalId, ev.igAccountId), eq(s.connectedAccounts.status, "connected")));
    const targets = accounts.filter((a) => (provider === "mock_instagram" ? a.mode === "mock" : a.mode === "live"));
    if (!targets.length) {
      await tx.update(s.webhookEvents).set({ status: "ignored", statusReason: "No connected account for this Instagram ID", processedAt: new Date() }).where(eq(s.webhookEvents.id, inserted[0]!.id));
      results.push({ eventKey: ev.eventKey, status: "ignored_unknown_account" });
      continue;
    }
    for (const acct of targets) {
      await enqueue(tx, {
        type: "inbox.process_event",
        workspaceId: acct.workspaceId,
        payload: { webhookEventId: inserted[0]!.id, accountId: acct.id },
        idempotencyKey: `inbox:${acct.id}:${ev.eventKey}`,
        correlationId,
      });
    }
    await tx.update(s.webhookEvents).set({ workspaceId: targets[0]!.workspaceId }).where(eq(s.webhookEvents.id, inserted[0]!.id));
    results.push({ eventKey: ev.eventKey, status: "queued" });
  }
  return results;
}

async function logStage(ctx: Ctx, conversationId: string, action: string, metadata: Record<string, unknown>, result: "success" | "blocked" | "info" | "failure" = "info") {
  await audit(ctx, { action: `inbox.${action}`, targetType: "inbox_conversation", targetId: conversationId, result, metadata });
}

/** Rule selection: enabled comment-to-DM rules for this account whose trigger, intent, product and schedule match. */
async function matchRule(ctx: Ctx, account: AccountRow, conv: Conversation, text: string, intent: Intent, productId: string | null, campaignId: string | null) {
  const rules = await ctx.tx
    .select()
    .from(s.automationRules)
    .where(and(eq(s.automationRules.workspaceId, ctx.workspaceId), eq(s.automationRules.kind, "comment_to_dm"), eq(s.automationRules.enabled, true), or(eq(s.automationRules.accountId, account.id), isNull(s.automationRules.accountId))))
    .orderBy(desc(s.automationRules.updatedAt));
  for (const r of rules) {
    const cfg = commentToDmConfigSchema.safeParse(r.config);
    if (!cfg.success) continue;
    if (r.campaignId && r.campaignId !== campaignId) continue;
    if (!cfg.data.allowedIntents.includes(intent)) continue;
    if (!triggerMatches(cfg.data, text)) continue;
    if (cfg.data.productIds.length && (!productId || !cfg.data.productIds.includes(productId))) continue;
    if (r.activeFrom && r.activeFrom > new Date()) continue;
    if (r.activeUntil && r.activeUntil < new Date()) continue;
    if (!withinSchedule(cfg.data, r.timezone ?? "UTC")) continue;
    void conv;
    return { rule: r, config: cfg.data };
  }
  return null;
}

/** Full pipeline for one inbound comment or DM. Every stage is logged, including ignored/blocked events. */
export async function processInboundEvent(jc: JobContext, webhookEventId: string, accountId: string) {
  const ev = await jc.system(async (tx) => (await tx.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, webhookEventId)).limit(1))[0]);
  if (!ev) return { skipped: "missing event" };
  const e = ev.payload as unknown as NormalizedEvent & { timestamp: string };
  const outcome = await jc.tenant(async (ctx) => {
    const account = await getAccount(ctx, accountId);
    if (e.kind === "comment" && account.settings.commentMonitoring === false) {
      await jc.system((tx) => tx.update(s.webhookEvents).set({ status: "ignored", statusReason: "Comment monitoring disabled for account", processedAt: new Date() }).where(eq(s.webhookEvents.id, webhookEventId)));
      return { kind: "ignored" as const, ignored: "monitoring_disabled" };
    }
    // Contact + conversation + message, deduplicated by provider IDs.
    const [contact] = await ctx.tx
      .insert(s.contactRecords)
      .values({ workspaceId: ctx.workspaceId, provider: "instagram", externalId: e.fromId, username: e.fromUsername ?? null, lastInboundDmAt: e.kind === "dm" ? new Date(e.timestamp) : null })
      .onConflictDoUpdate({
        target: [s.contactRecords.workspaceId, s.contactRecords.provider, s.contactRecords.externalId],
        set: { username: sql`coalesce(${e.fromUsername ?? null}, ${s.contactRecords.username})`, ...(e.kind === "dm" ? { lastInboundDmAt: new Date(e.timestamp) } : {}) },
      })
      .returning();
    const channel = e.kind === "comment" ? "instagram_comment" : "instagram_dm";
    const threadId = e.kind === "comment" ? e.commentId! : e.fromId;
    const linked = e.mediaId
      ? (await ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.publishedMediaId, e.mediaId))).limit(1))[0]
      : undefined;
    const [conv] = await ctx.tx
      .insert(s.inboxConversations)
      .values({
        workspaceId: ctx.workspaceId,
        accountId,
        channel,
        externalThreadId: threadId,
        contactId: contact!.id,
        mediaExternalId: e.mediaId ?? null,
        mediaProductType: e.mediaProductType ?? null,
        contentItemId: linked?.id ?? null,
        lastInboundAt: new Date(e.timestamp),
        lastMessageAt: new Date(e.timestamp),
      })
      .onConflictDoUpdate({
        target: [s.inboxConversations.workspaceId, s.inboxConversations.channel, s.inboxConversations.externalThreadId],
        set: { lastInboundAt: new Date(e.timestamp), lastMessageAt: new Date(e.timestamp), updatedAt: new Date() },
      })
      .returning();
    const msgExt = e.kind === "comment" ? e.commentId! : e.messageId!;
    const msgIns = await ctx.tx
      .insert(s.inboxMessages)
      .values({ workspaceId: ctx.workspaceId, conversationId: conv!.id, direction: "inbound", kind: e.kind === "comment" ? "comment" : "dm", externalId: msgExt, text: e.text.slice(0, 2200), authorExternalId: e.fromId, authorUsername: e.fromUsername ?? null, providerCreatedAt: new Date(e.timestamp) })
      .onConflictDoNothing()
      .returning();
    if (!msgIns[0]) return { kind: "duplicate" as const };
    await logStage(ctx, conv!.id, "received", { kind: e.kind, eventKey: ev.eventKey, mediaId: e.mediaId, linkedContent: linked?.id ?? null });
    // A reply by the person after our private reply counts as "replied-to".
    if (e.kind === "dm") {
      const priorPrivate = await ctx.tx.select({ id: s.replyDrafts.id }).from(s.replyDrafts).innerJoin(s.inboxConversations, eq(s.inboxConversations.id, s.replyDrafts.conversationId)).where(and(eq(s.replyDrafts.workspaceId, ctx.workspaceId), eq(s.inboxConversations.contactId, contact!.id), eq(s.replyDrafts.actionType, "private_comment_reply"), eq(s.replyDrafts.status, "sent"))).limit(1);
      if (priorPrivate[0]) await logStage(ctx, conv!.id, "replied_to_private_reply", { draftId: priorPrivate[0].id });
    }
    return { kind: "ok" as const, conv: conv as Conversation, account: account as AccountRow, contact: contact as typeof s.contactRecords.$inferSelect, linked, messageId: msgIns[0].id };
  });
  if (outcome.kind !== "ok") {
    await jc.system((tx) => tx.update(s.webhookEvents).set({ status: "ignored", statusReason: outcome.kind, processedAt: new Date() }).where(eq(s.webhookEvents.id, webhookEventId)));
    return outcome;
  }
  const { conv, account, contact, linked, messageId } = outcome;

  // Classification: deterministic rules first; LLM (community_manager) may refine; safety overrides win.
  const rules = classifyIntentRules(e.text);
  let intent: Intent = rules.intent;
  let confidence = rules.confidence;
  let llmPrivate: string | null = null;
  let agentRunId: string | null = null;
  const llmConfigured = Boolean(env().LLM_API_KEY);
  if (llmConfigured && rules.intent !== "complaint" && rules.intent !== "spam") {
    try {
      const { executeAgentRun } = await import("../agents/orchestrator");
      const runId = await jc.tenant(async (ctx) => {
        const [run] = await ctx.tx
          .insert(s.agentRuns)
          .values({ workspaceId: ctx.workspaceId, agentRole: "community_manager", state: "REQUESTED", input: { text: e.text, channel: conv.channel, linkedProductIds: linked?.productIds ?? [] }, maxSteps: 2, subjectType: "inbox_conversation", subjectId: conv.id, correlationId: jc.correlationId })
          .returning();
        return run!.id;
      });
      agentRunId = runId;
      const r = await executeAgentRun(jc, runId);
      const out = r.output as { intent?: Intent; confidence?: number; privateReply?: string } | undefined;
      if (out?.intent) {
        // Never let the model downgrade a sensitive classification or invent certainty the rules lack.
        if (!(rules.intent === "support" && out.intent !== "complaint")) {
          intent = out.intent;
          confidence = out.confidence ?? confidence;
        }
        llmPrivate = out.privateReply ?? null;
      }
    } catch (err) {
      jc.log.warn("community_manager_failed", { error: err });
    }
  }

  return jc.tenant(async (ctx) => {
    const injection = detectInjection(e.text);
    const catalog = await listProducts(ctx);
    const domains = await listAllowedDomains(ctx);
    const resolution = resolveProduct(e.text, linked?.productIds ?? [], catalog);
    const promotion = linked?.promotionId
      ? ((await ctx.tx.select().from(s.promotionOffers).where(and(eq(s.promotionOffers.id, linked.promotionId), eq(s.promotionOffers.workspaceId, ctx.workspaceId))).limit(1))[0] ?? null)
      : null;
    const activePromo = promotion && promotion.status !== "cancelled" && (!promotion.endsAt || promotion.endsAt > new Date()) && (!promotion.startsAt || promotion.startsAt <= new Date()) ? promotion : null;
    const match = await matchRule(ctx, account, conv, e.text, intent, resolution.product?.id ?? null, linked?.campaignId ?? null);
    const minConfidence = match?.config.minConfidence ?? 0.7;
    const plan = planReplies({ intent, confidence, username: e.fromUsername, resolution, promotion: activePromo, rule: match?.config ?? null, minConfidence, injectionFlag: injection.flagged, allowedDomains: domains, llmPrivateReply: llmPrivate });
    const isLead = ["product_link", "price", "purchase_intent", "stock_variant", "offer", "delivery"].includes(intent);
    await logStage(ctx, conv.id, "classified", { intent, confidence, rules: rules.intent, llm: Boolean(agentRunId), agentRunId, product: resolution.product?.id ?? null, productConfidence: resolution.confidence, productReason: resolution.reason, injection: injection.signals, rule: match?.rule.id ?? null });

    if (intent === "spam") {
      await ctx.tx.update(s.inboxConversations).set({ status: "ignored", intent, intentConfidence: String(confidence), updatedAt: new Date() }).where(eq(s.inboxConversations.id, conv.id));
      await logStage(ctx, conv.id, "ignored", { reason: "spam" });
      await jc.system((tx) => tx.update(s.webhookEvents).set({ status: "processed", statusReason: "spam", processedAt: new Date() }).where(eq(s.webhookEvents.id, webhookEventId)));
      return { status: "ignored_spam" };
    }

    const isComment = conv.channel === "instagram_comment";
    const privateElig = isComment ? await privateReplyEligibility(ctx, conv, account) : await dmEligibility(ctx, conv, account);
    const publicElig = isComment ? await publicReplyEligibility(ctx, conv, account) : { eligible: false, reasons: ["Not a comment"] };
    await ctx.tx
      .update(s.inboxConversations)
      .set({
        intent,
        intentConfidence: String(confidence),
        matchedProductId: resolution.product?.id ?? null,
        isLead,
        status: plan.escalate ? "needs_human" : "open",
        escalationReasons: plan.escalationReasons,
        eligibility: { private: privateElig, public: publicElig, checkedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(s.inboxConversations.id, conv.id));
    if (isLead) await ctx.tx.update(s.contactRecords).set({ isLead: true }).where(eq(s.contactRecords.id, contact.id));

    if (plan.escalate) {
      await logStage(ctx, conv.id, "escalated", { reasons: plan.escalationReasons }, "blocked");
      await notify(ctx, { kind: "inbox_escalation", title: `Needs human: ${intent.replace("_", " ")} on Instagram`, body: plan.escalationReasons.join("; "), link: `/inbox?c=${conv.id}` });
      await jc.system((tx) => tx.update(s.webhookEvents).set({ status: "processed", statusReason: "escalated", processedAt: new Date() }).where(eq(s.webhookEvents.id, webhookEventId)));
      return { status: "escalated", reasons: plan.escalationReasons };
    }

    const drafts: Draft[] = [];
    const mk = async (actionType: "public_comment_reply" | "private_comment_reply" | "dm_reply", text: string, blocked: string[]) => {
      const [d] = await ctx.tx
        .insert(s.replyDrafts)
        .values({ workspaceId: ctx.workspaceId, conversationId: conv.id, sourceMessageId: messageId, actionType, text, url: plan.url, productId: resolution.product?.id ?? null, status: blocked.length ? "blocked" : "draft", blockedReasons: blocked, automationRuleId: match?.rule.id ?? null, agentRunId })
        .returning();
      drafts.push(d!);
      await logStage(ctx, conv.id, blocked.length ? "draft_blocked" : "drafted", { draftId: d!.id, actionType, blocked }, blocked.length ? "blocked" : "info");
      return d!;
    };
    const sendPublic = match ? match.config.sendPublicReply : true;
    const sendPrivate = match ? match.config.sendPrivateReply : true;
    if (isComment && plan.publicReply && sendPublic) await mk("public_comment_reply", plan.publicReply, publicElig.eligible ? [] : publicElig.reasons);
    if (plan.privateReply && sendPrivate) await mk(isComment ? "private_comment_reply" : "dm_reply", plan.privateReply, privateElig.eligible ? [] : privateElig.reasons);

    // Approval mode: bounded auto (pre-approved rule) → send; approve_every/default → Approval Center; human_only → drafts only.
    const mode = match?.rule.approvalMode ?? "approve_every";
    for (const d of drafts.filter((x) => x.status === "draft")) {
      if (mode === "human_only") continue;
      if (mode === "bounded_auto" && match) {
        await ctx.tx.update(s.replyDrafts).set({ status: "approved" }).where(eq(s.replyDrafts.id, d.id));
        await enqueue(ctx.tx, { type: "inbox.send_reply", workspaceId: ctx.workspaceId, payload: { draftId: d.id, ruleId: match.rule.id }, idempotencyKey: `inbox.send:${d.id}`, correlationId: jc.correlationId });
        await logStage(ctx, conv.id, "auto_send_queued", { draftId: d.id, ruleId: match.rule.id, ruleVersion: match.rule.version });
      } else {
        const actionType = d.actionType as ActionType;
        const ar = await requestApproval(workerAsRequester(ctx), { actionType, subjectId: d.id });
        await ctx.tx.update(s.replyDrafts).set({ status: "pending_approval", approvalRequestId: ar.id }).where(eq(s.replyDrafts.id, d.id));
        await logStage(ctx, conv.id, "approval_requested", { draftId: d.id, approvalId: ar.id, actionType });
      }
    }
    const anyPending = drafts.some((d) => d.status === "draft") && mode !== "bounded_auto";
    await ctx.tx.update(s.inboxConversations).set({ status: drafts.every((d) => d.status === "blocked") ? "needs_human" : anyPending ? "awaiting_approval" : "open" }).where(eq(s.inboxConversations.id, conv.id));
    await jc.system((tx) => tx.update(s.webhookEvents).set({ status: "processed", processedAt: new Date() }).where(eq(s.webhookEvents.id, webhookEventId)));
    return { status: "drafted", drafts: drafts.map((d) => ({ id: d.id, actionType: d.actionType, status: d.status })) };
  });
}

/** The worker requests approvals on behalf of the system; it can never decide them. */
function workerAsRequester(ctx: Ctx): Ctx {
  return { ...ctx, role: "creator" };
}

registerJob("inbox.process_event", {
  async run(jc, payload) {
    return processInboundEvent(jc, String(payload.webhookEventId), String(payload.accountId));
  },
});

// ───────────────────────────── Approval subjects for replies ─────────────────────────────

async function getDraft(ctx: Ctx, id: string) {
  const r = await ctx.tx.select().from(s.replyDrafts).where(and(eq(s.replyDrafts.id, id), eq(s.replyDrafts.workspaceId, ctx.workspaceId))).limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Reply draft not found");
  return r[0];
}

async function draftContext(ctx: Ctx, draftId: string) {
  const draft = await getDraft(ctx, draftId);
  const conv = (await ctx.tx.select().from(s.inboxConversations).where(eq(s.inboxConversations.id, draft.conversationId)).limit(1))[0]!;
  const account = await getAccount(ctx, conv.accountId);
  const contact = conv.contactId ? (await ctx.tx.select().from(s.contactRecords).where(eq(s.contactRecords.id, conv.contactId)).limit(1))[0] : undefined;
  const source = draft.sourceMessageId ? (await ctx.tx.select().from(s.inboxMessages).where(eq(s.inboxMessages.id, draft.sourceMessageId)).limit(1))[0] : undefined;
  return { draft, conv, account, contact, source };
}

function replySubject(actionType: "public_comment_reply" | "private_comment_reply" | "dm_reply") {
  return {
    subjectType: "reply_draft",
    async build(ctx: Ctx, draftId: string) {
      const { draft, conv, account, contact, source } = await draftContext(ctx, draftId);
      const recipient = contact?.username ? `@${contact.username}` : (contact?.externalId ?? "unknown");
      return {
        version: draft.version,
        payload: { draftId, actionType, text: draft.text, url: draft.url, accountId: account.id, recipient: contact?.externalId ?? null, threadId: conv.externalThreadId, ruleId: draft.automationRuleId },
        summary: {
          title: actionType === "public_comment_reply" ? `Public reply to ${recipient}` : actionType === "private_comment_reply" ? `Private reply (DM) to ${recipient}` : `DM reply to ${recipient}`,
          channel: actionType === "public_comment_reply" ? "Instagram comment (public)" : "Instagram Direct (private)",
          destination: `@${account.username ?? account.displayName}`,
          mode: account.mode as "live" | "mock",
          recipient: `${recipient}${source ? ` — in reply to: “${source.text.slice(0, 140)}”` : ""}`,
          audience: actionType === "public_comment_reply" ? "Visible to everyone who can see the post" : "Only the recipient",
          landingPage: draft.url,
          risks: [
            ...(conv.intent ? [`Intent: ${conv.intent} (confidence ${Number(conv.intentConfidence ?? 0).toFixed(2)})`] : []),
            ...(actionType === "private_comment_reply" ? ["Only one private reply is allowed per comment; it must be sent within 7 days of the comment."] : []),
            ...(actionType === "dm_reply" ? ["Must be sent within 24 hours of the person's latest message."] : []),
          ],
          sideEffects: [account.mode === "mock" ? "MOCK account: nothing is sent to Instagram." : actionType === "public_comment_reply" ? "Posts a public reply under the comment." : "Sends a private Instagram message to this person."],
          preview: { text: draft.text, url: draft.url },
        },
      };
    },
    async onApproved(ctx: Ctx, approval: typeof s.approvalRequests.$inferSelect) {
      await ctx.tx.update(s.replyDrafts).set({ status: "approved", updatedAt: new Date() }).where(eq(s.replyDrafts.id, approval.subjectId));
      await enqueue(ctx.tx, { type: "inbox.send_reply", workspaceId: ctx.workspaceId, payload: { draftId: approval.subjectId, approvalId: approval.id }, idempotencyKey: `inbox.send:${approval.subjectId}:${approval.id}`, correlationId: ctx.correlationId });
    },
    async onClosed(ctx: Ctx, approval: typeof s.approvalRequests.$inferSelect, status: string) {
      if (status === "executed") return;
      const d = await getDraft(ctx, approval.subjectId).catch(() => null);
      if (d && ["pending_approval", "approved"].includes(d.status)) await ctx.tx.update(s.replyDrafts).set({ status: status === "rejected" ? "discarded" : "draft", updatedAt: new Date() }).where(eq(s.replyDrafts.id, d.id));
    },
  };
}
registerApprovalSubject("public_comment_reply", replySubject("public_comment_reply"));
registerApprovalSubject("private_comment_reply", replySubject("private_comment_reply"));
registerApprovalSubject("dm_reply", replySubject("dm_reply"));

// ───────────────────────────── Sending ─────────────────────────────

registerJob("inbox.send_reply", {
  external: true,
  uncertainOnCrash: true,
  async run(jc, payload) {
    const draftId = String(payload.draftId);
    const approvalId = payload.approvalId ? String(payload.approvalId) : null;
    const ruleId = payload.ruleId ? String(payload.ruleId) : null;
    const base = await jc.tenant((ctx) => draftContext(ctx, draftId));
    const actionType = base.draft.actionType as "public_comment_reply" | "private_comment_reply" | "dm_reply";
    // Private replies are keyed by comment so at most one can ever be sent per comment.
    const idempotencyKey =
      actionType === "private_comment_reply" ? `private_reply:${base.account.id}:${base.conv.externalThreadId}` : `${actionType}:${draftId}:${approvalId ?? ruleId}`;
    const res = await runExternalAction(jc, {
      actionType,
      provider: "instagram",
      accountId: base.account.id,
      subjectType: "reply_draft",
      subjectId: draftId,
      idempotencyKey,
      approvalRequestId: approvalId,
      automationRuleId: ruleId,
      async authorize(ctx) {
        const { draft, conv, account } = await draftContext(ctx, draftId);
        const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
        let approval = null;
        let currentHash = hashPayload({ draftId, text: draft.text });
        if (approvalId) {
          const l = await loadApprovalForExecution(ctx, approvalId);
          approval = l.approval;
          currentHash = l.currentHash;
        }
        let policy: BoundedPolicy | null = null;
        if (ruleId) {
          const rule = (await ctx.tx.select().from(s.automationRules).where(and(eq(s.automationRules.id, ruleId), eq(s.automationRules.workspaceId, ctx.workspaceId))).limit(1))[0];
          if (!rule) throw new AppError("POLICY_BLOCKED", "Automation rule no longer exists");
          const cfg = commentToDmConfigSchema.parse(rule.config);
          const hourly = await peekRateLimit(ctx.tx, `rule:${rule.id}:hour`, cfg.limits.maxPerHour, 3600);
          const daily = await peekRateLimit(ctx.tx, `rule:${rule.id}:day`, cfg.limits.maxPerDay, 86400);
          policy = {
            id: rule.id,
            enabled: rule.enabled,
            approvalMode: rule.approvalMode,
            enabledBy: rule.enabledBy,
            allowedActionTypes: [...(cfg.sendPublicReply ? ["public_comment_reply"] : []), ...(cfg.sendPrivateReply ? ["private_comment_reply"] : [])],
            accountId: rule.accountId,
            activeFrom: rule.activeFrom,
            activeUntil: rule.activeUntil,
            withinRateLimit: hourly.allowed && daily.allowed,
          };
          // Rule edits after drafting invalidate auto-send: the draft must have been produced by this exact rule version.
          if (draft.automationRuleId !== rule.id) throw new AppError("POLICY_BLOCKED", "Draft was not produced by this rule");
          if (actionType === "private_comment_reply" && conv.contactId) {
            const c = (await ctx.tx.select().from(s.contactRecords).where(eq(s.contactRecords.id, conv.contactId)).limit(1))[0];
            if (c?.lastPrivateReplyAt && Date.now() - c.lastPrivateReplyAt.getTime() < cfg.limits.perUserCooldownHours * 3600_000) {
              throw new AppError("RATE_LIMITED", `Recipient received an automated message within the last ${cfg.limits.perUserCooldownHours}h (cooldown)`);
            }
          }
        }
        const decision = evaluateAction({
          actionType,
          actorType: "worker",
          workspace: ws,
          accountId: account.id,
          account: { automationPaused: account.automationPaused, status: account.status, mode: account.mode },
          currentPayloadHash: currentHash,
          approval,
          policy,
          mocksAllowed: env().mocksAllowed,
        });
        if (!decision.allowed) throw new AppError("POLICY_BLOCKED", decision.reasons.join(" "));
        // Re-check platform eligibility and grounding at send time (windows can close while awaiting approval).
        const elig = actionType === "private_comment_reply" ? await privateReplyEligibilityForSend(ctx, conv, account, idempotencyKey) : actionType === "dm_reply" ? await dmEligibility(ctx, conv, account) : await publicReplyEligibility(ctx, conv, account);
        if (!elig.eligible) throw new AppError("POLICY_BLOCKED", elig.reasons.join(" "));
        const product = draft.productId ? (await listProducts(ctx)).find((p) => p.id === draft.productId) ?? null : null;
        const grounded = validateGroundedText(draft.text, product, await listAllowedDomains(ctx));
        if (!grounded.ok) throw new AppError("POLICY_BLOCKED", `Reply failed grounding checks: ${grounded.problems.join("; ")}`);
        await consumeRateLimit(ctx.tx, `send:${account.id}:hour`, ACCOUNT_HOURLY_SEND_LIMIT, 3600, { throwOnLimit: true });
        if (ruleId) {
          await consumeRateLimit(ctx.tx, `rule:${ruleId}:hour`, Number.MAX_SAFE_INTEGER, 3600);
          await consumeRateLimit(ctx.tx, `rule:${ruleId}:day`, Number.MAX_SAFE_INTEGER, 86400);
        }
        await ctx.tx.update(s.replyDrafts).set({ status: "sending", updatedAt: new Date() }).where(eq(s.replyDrafts.id, draftId));
        return { payloadHash: currentHash, mode: account.mode as "live" | "mock" };
      },
      async execute(ctx) {
        const { draft, conv, account, contact } = await draftContext(ctx, draftId);
        const ig = await instagramAdapter(ctx, account);
        if (actionType === "public_comment_reply") {
          const r = await ig.replyToComment(conv.externalThreadId, draft.text);
          return { providerRef: r.id, summary: { mode: ig.mode } };
        }
        if (actionType === "private_comment_reply") {
          const r = await ig.sendPrivateReply(conv.externalThreadId, draft.text);
          return { providerRef: r.messageId, summary: { recipientId: r.recipientId ?? null, mode: ig.mode } };
        }
        const r = await ig.sendMessage(contact!.externalId, draft.text);
        return { providerRef: r.messageId, summary: { mode: ig.mode } };
      },
      // Instagram offers no lookup for sent private replies/DMs: ambiguous outcomes need a human.
      reconcile: undefined,
      async onSuccess(ctx, result, row) {
        const { draft, conv } = await draftContext(ctx, draftId);
        await ctx.tx.update(s.replyDrafts).set({ status: "sent", externalActionId: row.id, updatedAt: new Date() }).where(eq(s.replyDrafts.id, draftId));
        await ctx.tx
          .insert(s.inboxMessages)
          .values({ workspaceId: ctx.workspaceId, conversationId: conv.id, direction: "outbound", kind: actionType === "public_comment_reply" ? "public_reply" : actionType === "private_comment_reply" ? "private_reply" : "dm", externalId: result.providerRef, text: draft.text, mode: row.mode, providerCreatedAt: new Date() })
          .onConflictDoNothing();
        if (actionType !== "public_comment_reply" && conv.contactId) await ctx.tx.update(s.contactRecords).set({ lastPrivateReplyAt: new Date() }).where(eq(s.contactRecords.id, conv.contactId));
        if (approvalId) await markApprovalExecuted(ctx, approvalId);
        const remaining = await ctx.tx.select({ id: s.replyDrafts.id }).from(s.replyDrafts).where(and(eq(s.replyDrafts.conversationId, conv.id), inArray(s.replyDrafts.status, ["draft", "pending_approval", "approved", "sending"])));
        if (!remaining.length) await ctx.tx.update(s.inboxConversations).set({ status: "handled", updatedAt: new Date() }).where(eq(s.inboxConversations.id, conv.id));
        await logStage(ctx, conv.id, "sent", { draftId, actionType, mode: row.mode, providerRef: result.providerRef, ruleId, approvalId }, "success");
      },
      async onFailure(ctx, error, final) {
        const { conv } = await draftContext(ctx, draftId);
        await ctx.tx.update(s.replyDrafts).set({ status: final ? "failed" : "approved", blockedReasons: [error], updatedAt: new Date() }).where(eq(s.replyDrafts.id, draftId));
        if (final) {
          await ctx.tx.update(s.inboxConversations).set({ status: "needs_human", escalationReasons: [error] }).where(eq(s.inboxConversations.id, conv.id));
          await logStage(ctx, conv.id, "send_failed", { draftId, actionType, error }, "failure");
        }
      },
    });
    return { status: res.status };
  },
});

/** Send-time variant: the current action's own idempotency row must not count as a prior reply. */
async function privateReplyEligibilityForSend(ctx: Ctx, conv: Conversation, account: AccountRow, ownKey: string) {
  const e = await privateReplyEligibility(ctx, conv, account);
  const own = (await ctx.tx.select().from(s.externalActions).where(eq(s.externalActions.idempotencyKey, ownKey)).limit(1))[0];
  if (own && ["pending", "failed", "executing"].includes(own.status)) {
    e.reasons = e.reasons.filter((r) => !r.startsWith("A private reply was already sent"));
    e.eligible = e.reasons.length === 0;
  }
  return e;
}

// ───────────────────────────── Inbox queries & human actions ─────────────────────────────

export const inboxQuery = z.object({
  tab: z.enum(["all", "comments", "dms", "leads", "needs_human", "automation_paused"]).default("all"),
  accountId: z.uuid().optional(),
});

export async function listConversations(ctx: Ctx, q: z.infer<typeof inboxQuery>) {
  requirePermission(ctx, "inbox.read");
  const conds: SQL[] = [eq(s.inboxConversations.workspaceId, ctx.workspaceId)];
  if (q.accountId) conds.push(eq(s.inboxConversations.accountId, q.accountId));
  if (q.tab === "comments") conds.push(eq(s.inboxConversations.channel, "instagram_comment"));
  if (q.tab === "dms") conds.push(eq(s.inboxConversations.channel, "instagram_dm"));
  if (q.tab === "leads") conds.push(eq(s.inboxConversations.isLead, true));
  if (q.tab === "needs_human") conds.push(eq(s.inboxConversations.status, "needs_human"));
  const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
  const accounts = await ctx.tx.select().from(s.connectedAccounts).where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId));
  if (q.tab === "automation_paused") {
    const paused = accounts.filter((a) => a.automationPaused || ws.automationPaused).map((a) => a.id);
    conds.push(or(eq(s.inboxConversations.humanTakeover, true), paused.length ? inArray(s.inboxConversations.accountId, paused) : sql`false`)!);
  }
  const rows = await ctx.tx
    .select({ c: s.inboxConversations, contact: s.contactRecords })
    .from(s.inboxConversations)
    .leftJoin(s.contactRecords, eq(s.contactRecords.id, s.inboxConversations.contactId))
    .where(and(...conds))
    .orderBy(desc(s.inboxConversations.lastMessageAt))
    .limit(200);
  const ids = rows.map((r) => r.c.id);
  const last = ids.length
    ? await ctx.tx.execute<{ conversation_id: string; text: string; direction: string }>(
        sql`select distinct on (conversation_id) conversation_id, text, direction from inbox_messages where workspace_id = ${ctx.workspaceId} and conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by conversation_id, created_at desc`,
      )
    : { rows: [] };
  return rows.map((r) => ({ ...r.c, contact: r.contact, account: accounts.find((a) => a.id === r.c.accountId) ?? null, lastMessage: last.rows.find((l) => l.conversation_id === r.c.id) ?? null }));
}

export async function conversationDetail(ctx: Ctx, id: string) {
  requirePermission(ctx, "inbox.read");
  const conv = (await ctx.tx.select().from(s.inboxConversations).where(and(eq(s.inboxConversations.id, id), eq(s.inboxConversations.workspaceId, ctx.workspaceId))).limit(1))[0];
  if (!conv) throw new AppError("NOT_FOUND", "Conversation not found");
  const [messages, drafts, history, contact, account] = await Promise.all([
    ctx.tx.select().from(s.inboxMessages).where(eq(s.inboxMessages.conversationId, id)).orderBy(s.inboxMessages.createdAt),
    ctx.tx.select().from(s.replyDrafts).where(eq(s.replyDrafts.conversationId, id)).orderBy(desc(s.replyDrafts.createdAt)),
    ctx.tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.workspaceId, ctx.workspaceId), eq(s.auditEvents.targetId, id))).orderBy(desc(s.auditEvents.createdAt)).limit(100),
    conv.contactId ? ctx.tx.select().from(s.contactRecords).where(eq(s.contactRecords.id, conv.contactId)).limit(1) : Promise.resolve([]),
    getAccount(ctx, conv.accountId),
  ]);
  const product = conv.matchedProductId ? (await ctx.tx.select().from(s.products).where(eq(s.products.id, conv.matchedProductId)).limit(1))[0] ?? null : null;
  const content = conv.contentItemId ? (await ctx.tx.select().from(s.contentItems).where(eq(s.contentItems.id, conv.contentItemId)).limit(1))[0] ?? null : null;
  const draftApprovals = drafts.map((d) => d.approvalRequestId).filter(Boolean) as string[];
  const approvals = draftApprovals.length ? await ctx.tx.select().from(s.approvalRequests).where(inArray(s.approvalRequests.id, draftApprovals)) : [];
  const draftHistory = drafts.length ? await ctx.tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.workspaceId, ctx.workspaceId), inArray(s.auditEvents.targetId, drafts.map((d) => d.id)))).orderBy(desc(s.auditEvents.createdAt)) : [];
  return { conversation: conv, messages, drafts, approvals, history: [...history, ...draftHistory].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()), contact: contact[0] ?? null, account, product, content };
}

/** Human takeover immediately disables automation for this conversation and voids pending drafts' approvals. */
export async function setHumanTakeover(ctx: Ctx, id: string, takeover: boolean) {
  requirePermission(ctx, "inbox.reply");
  const userId = requireUser(ctx);
  const conv = (await conversationDetail(ctx, id)).conversation;
  await ctx.tx
    .update(s.inboxConversations)
    .set({ humanTakeover: takeover, assignedTo: takeover ? userId : null, status: takeover ? "needs_human" : conv.status === "needs_human" ? "open" : conv.status, updatedAt: new Date() })
    .where(eq(s.inboxConversations.id, id));
  if (takeover) {
    const drafts = await ctx.tx.select().from(s.replyDrafts).where(and(eq(s.replyDrafts.conversationId, id), inArray(s.replyDrafts.status, ["draft", "pending_approval", "approved"])));
    for (const d of drafts) {
      await invalidateApprovalsForSubject(ctx, d.id, "Human took over the conversation");
      await ctx.tx.update(s.replyDrafts).set({ status: "discarded", updatedAt: new Date() }).where(eq(s.replyDrafts.id, d.id));
    }
  }
  await audit(ctx, { action: takeover ? "inbox.human_takeover" : "inbox.human_released", targetType: "inbox_conversation", targetId: id });
}

export const manualDraftSchema = z.object({
  actionType: z.enum(["public_comment_reply", "private_comment_reply", "dm_reply"]),
  text: z.string().trim().min(1).max(1000),
  productId: z.uuid().nullable().optional(),
});

/** A human-written reply. It still goes through approval + eligibility + grounding checks before sending. */
export async function createManualDraft(ctx: Ctx, conversationId: string, input: z.infer<typeof manualDraftSchema>) {
  requirePermission(ctx, "inbox.reply");
  const { conversation: conv, account } = await conversationDetail(ctx, conversationId);
  if (conv.channel === "instagram_dm" && input.actionType !== "dm_reply") throw new AppError("VALIDATION_FAILED", "DM conversations only support DM replies");
  if (conv.channel === "instagram_comment" && input.actionType === "dm_reply") throw new AppError("VALIDATION_FAILED", "Reply to a comment privately with a private reply; ongoing DMs need the person to message first");
  const products = await listProducts(ctx);
  const product = input.productId ? products.find((p) => p.id === input.productId) ?? null : null;
  if (input.productId && !product) throw new AppError("NOT_FOUND", "Product not found");
  const grounded = validateGroundedText(input.text, product, await listAllowedDomains(ctx));
  const elig = input.actionType === "private_comment_reply" ? await privateReplyEligibility(ctx, conv, account) : input.actionType === "dm_reply" ? await dmEligibility(ctx, conv, account) : await publicReplyEligibility(ctx, conv, account);
  // Human takeover is the human's own conversation: ignore that reason for manual drafts.
  const blocked = [...grounded.problems, ...elig.reasons.filter((r) => !r.startsWith("A human has taken over"))];
  const [d] = await ctx.tx
    .insert(s.replyDrafts)
    .values({ workspaceId: ctx.workspaceId, conversationId, actionType: input.actionType, text: input.text, url: extractUrls(input.text)[0] ?? null, productId: product?.id ?? null, status: blocked.length ? "blocked" : "draft", blockedReasons: blocked })
    .returning();
  await audit(ctx, { action: blocked.length ? "inbox.draft_blocked" : "inbox.drafted", targetType: "reply_draft", targetId: d!.id, result: blocked.length ? "blocked" : "info", metadata: { actionType: input.actionType, manual: true, blocked } });
  if (!blocked.length) {
    const ar = await requestApproval(ctx, { actionType: input.actionType, subjectId: d!.id });
    await ctx.tx.update(s.replyDrafts).set({ status: "pending_approval", approvalRequestId: ar.id }).where(eq(s.replyDrafts.id, d!.id));
    return { draft: { ...d!, status: "pending_approval", approvalRequestId: ar.id }, approval: ar };
  }
  return { draft: d!, approval: null };
}

/** Editing a draft's text is material: it creates a new draft version and invalidates its approval. */
export async function editDraft(ctx: Ctx, draftId: string, text: string) {
  requirePermission(ctx, "inbox.reply");
  const d = await getDraft(ctx, draftId);
  if (!["draft", "pending_approval", "approved", "blocked"].includes(d.status)) throw new AppError("CONFLICT", `Draft is ${d.status}`);
  await invalidateApprovalsForSubject(ctx, draftId, "Reply text edited");
  const { conversation: conv, account } = await conversationDetail(ctx, d.conversationId);
  const product = d.productId ? (await listProducts(ctx)).find((p) => p.id === d.productId) ?? null : null;
  const grounded = validateGroundedText(text, product, await listAllowedDomains(ctx));
  const elig = d.actionType === "private_comment_reply" ? await privateReplyEligibility(ctx, conv, account) : d.actionType === "dm_reply" ? await dmEligibility(ctx, conv, account) : await publicReplyEligibility(ctx, conv, account);
  const blocked = [...grounded.problems, ...elig.reasons.filter((r) => !r.startsWith("A human has taken over"))];
  await ctx.tx.update(s.replyDrafts).set({ text, version: d.version + 1, status: blocked.length ? "blocked" : "draft", blockedReasons: blocked, approvalRequestId: null, automationRuleId: null, updatedAt: new Date() }).where(eq(s.replyDrafts.id, draftId));
  await audit(ctx, { action: "inbox.draft_edited", targetType: "reply_draft", targetId: draftId, metadata: { version: d.version + 1, blocked } });
  if (!blocked.length) {
    const ar = await requestApproval(ctx, { actionType: d.actionType as ActionType, subjectId: draftId });
    await ctx.tx.update(s.replyDrafts).set({ status: "pending_approval", approvalRequestId: ar.id }).where(eq(s.replyDrafts.id, draftId));
  }
  return getDraft(ctx, draftId);
}

export async function discardDraft(ctx: Ctx, draftId: string) {
  requirePermission(ctx, "inbox.reply");
  await getDraft(ctx, draftId);
  await invalidateApprovalsForSubject(ctx, draftId, "Draft discarded");
  await ctx.tx.update(s.replyDrafts).set({ status: "discarded", updatedAt: new Date() }).where(eq(s.replyDrafts.id, draftId));
  await audit(ctx, { action: "inbox.draft_discarded", targetType: "reply_draft", targetId: draftId });
}

export async function setContactFlags(ctx: Ctx, contactId: string, flags: { optedOut?: boolean; suppressed?: boolean }) {
  requirePermission(ctx, "inbox.reply");
  const r = await ctx.tx.update(s.contactRecords).set(flags).where(and(eq(s.contactRecords.id, contactId), eq(s.contactRecords.workspaceId, ctx.workspaceId))).returning();
  if (!r[0]) throw new AppError("NOT_FOUND", "Contact not found");
  await audit(ctx, { action: "inbox.contact_flags_changed", targetType: "contact", targetId: contactId, metadata: flags });
}

/** Funnel metrics computed from stored records only. Link clicks and sales are not tracked here. */
export async function inboxMetrics(ctx: Ctx, days = 30) {
  requirePermission(ctx, "inbox.read");
  const since = new Date(Date.now() - days * 86400_000);
  const drafts = await ctx.tx.select({ status: s.replyDrafts.status, actionType: s.replyDrafts.actionType, c: sql<number>`count(*)::int` }).from(s.replyDrafts).where(and(eq(s.replyDrafts.workspaceId, ctx.workspaceId), gte(s.replyDrafts.createdAt, since))).groupBy(s.replyDrafts.status, s.replyDrafts.actionType);
  const convs = await ctx.tx.select({ status: s.inboxConversations.status, c: sql<number>`count(*)::int` }).from(s.inboxConversations).where(and(eq(s.inboxConversations.workspaceId, ctx.workspaceId), gte(s.inboxConversations.createdAt, since))).groupBy(s.inboxConversations.status);
  const leads = await ctx.tx.select({ c: sql<number>`count(*)::int` }).from(s.inboxConversations).where(and(eq(s.inboxConversations.workspaceId, ctx.workspaceId), eq(s.inboxConversations.isLead, true), gte(s.inboxConversations.createdAt, since)));
  const repliedTo = await ctx.tx.select({ c: sql<number>`count(*)::int` }).from(s.auditEvents).where(and(eq(s.auditEvents.workspaceId, ctx.workspaceId), eq(s.auditEvents.action, "inbox.replied_to_private_reply"), gte(s.auditEvents.createdAt, since)));
  const sum = (pred: (d: (typeof drafts)[number]) => boolean) => drafts.filter(pred).reduce((a, d) => a + d.c, 0);
  return {
    windowDays: days,
    drafted: sum(() => true),
    awaitingApproval: sum((d) => d.status === "pending_approval"),
    approved: sum((d) => ["approved", "sending", "sent"].includes(d.status)),
    sent: sum((d) => d.status === "sent"),
    sentPrivate: sum((d) => d.status === "sent" && d.actionType !== "public_comment_reply"),
    blocked: sum((d) => d.status === "blocked"),
    failed: sum((d) => d.status === "failed"),
    repliedTo: repliedTo[0]?.c ?? 0,
    escalated: convs.filter((c) => c.status === "needs_human").reduce((a, c) => a + c.c, 0),
    ignored: convs.filter((c) => c.status === "ignored").reduce((a, c) => a + c.c, 0),
    leads: leads[0]?.c ?? 0,
    notTracked: ["Link clicks", "Sales attributed to replies"],
  };
}
