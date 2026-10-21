import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { checkUrl, extractUrls } from "../lib/url-safety";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { invalidateApprovalsForSubject } from "./approvals";
import { listAllowedDomains, listProducts } from "./company-brain";
import { notify } from "./notifications";
import { isValidTimezone } from "./workspace";

// ───────────────────────────── Natural-language parsing ─────────────────────────────

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30, a: 1, an: 1 };

export interface ParsedPromotion {
  discountType: "percent" | "fixed_amount" | "bogo" | "free_shipping" | null;
  discountValue: number | null;
  currency: string | null;
  durationDays: number | null;
  durationHours: number | null;
  allProducts: boolean;
  productHints: string[];
  startHint: "today" | "tomorrow" | null;
  landingPageUrl: string | null;
}

/**
 * Deterministic parser for promotion requests such as "Run 50% off on our products for three days".
 * It extracts only what is explicitly stated; anything else is reported as missing, never guessed.
 */
export function parsePromotionRequest(text: string): ParsedPromotion {
  const t = text.toLowerCase();
  const out: ParsedPromotion = { discountType: null, discountValue: null, currency: null, durationDays: null, durationHours: null, allProducts: false, productHints: [], startHint: null, landingPageUrl: null };

  const pct = t.match(/(\d{1,2}(?:\.\d+)?|100)\s?(?:%|percent)\s*(?:off|discount)?/);
  const fixed = text.match(/([$€£₹])\s?(\d+(?:\.\d{1,2})?)\s*off/i) ?? text.match(/(\d+(?:\.\d{1,2})?)\s?(usd|eur|gbp|inr)\s*off/i);
  if (pct) {
    out.discountType = "percent";
    out.discountValue = Number(pct[1]);
  } else if (fixed) {
    out.discountType = "fixed_amount";
    const sym = fixed[1]!;
    out.discountValue = Number(/^\d/.test(sym) ? fixed[1] : fixed[2]);
    const map: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", usd: "USD", eur: "EUR", gbp: "GBP", inr: "INR" };
    out.currency = map[(/^\d/.test(sym) ? fixed[2]! : sym).toLowerCase()] ?? null;
  } else if (/\b(bogo|buy one,? get one)\b/.test(t)) {
    out.discountType = "bogo";
  } else if (/\bfree (shipping|delivery)\b/.test(t)) {
    out.discountType = "free_shipping";
  }

  const dur = t.match(/\bfor (?:the next )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|a|an)\s*(day|days|hour|hours|week|weeks)\b/);
  if (dur) {
    const n = /^\d+$/.test(dur[1]!) ? Number(dur[1]) : (NUMBER_WORDS[dur[1]!] ?? null);
    if (n !== null) {
      if (dur[2]!.startsWith("hour")) out.durationHours = n;
      else out.durationDays = dur[2]!.startsWith("week") ? n * 7 : n;
    }
  } else if (/\b(this )?weekend\b/.test(t)) {
    out.durationDays = null; // "weekend" depends on locale/timezone: ask.
  }

  out.allProducts = /\b(all|every|entire|whole)\b.{0,15}\b(products?|items?|store|range|catalog|collection)\b|sitewide|site-wide|store-?wide/.test(t);
  const on = t.match(/\bon (?:our |the |all )?([a-z0-9 ,&-]{3,80}?)(?: for | from | starting | until |$|\.)/);
  if (on && !/^(products?|items?|everything|stuff)$/.test(on[1]!.trim())) out.productHints = on[1]!.split(/,| and | & /).map((x) => x.trim()).filter((x) => x.length > 2 && !/^(our|the)$/.test(x));
  if (/\btomorrow\b/.test(t)) out.startHint = "tomorrow";
  else if (/\b(today|now|immediately|starting now)\b/.test(t)) out.startHint = "today";
  out.landingPageUrl = extractUrls(text)[0] ?? null;
  return out;
}

// ───────────────────────────── Structured promotion ─────────────────────────────

export const promotionPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  discountType: z.enum(["percent", "fixed_amount", "bogo", "free_shipping", "other"]).nullable().optional(),
  discountValue: z.number().min(0).max(100000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  eligibleProductIds: z.array(z.uuid()).max(200).optional(),
  eligibleDescription: z.string().max(1000).nullable().optional(),
  exclusions: z.string().max(2000).nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").nullable().optional(),
  redemptionInstructions: z.string().max(2000).nullable().optional(),
  landingPageUrl: z.url().max(1000).nullable().optional(),
  customerEligibility: z.string().max(1000).nullable().optional(),
  stockNote: z.string().max(1000).nullable().optional(),
  terms: z.string().max(4000).nullable().optional(),
  approvedClaims: z.array(z.string().max(300)).max(20).optional(),
  adBudgetMinor: z.number().int().min(0).max(1e10).nullable().optional(),
  audienceNote: z.string().max(1000).nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
});

type PromotionRow = typeof s.promotionOffers.$inferSelect;

export const ESSENTIAL_FIELDS: Array<{ field: string; question: string }> = [
  { field: "discount", question: "What is the exact discount (type and value)?" },
  { field: "eligibleProducts", question: "Which products or services are included? (select from the catalog, or confirm all products)" },
  { field: "startsAt", question: "When exactly does the offer start (date and time)?" },
  { field: "endsAt", question: "When exactly does it end (date and time)?" },
  { field: "timezone", question: "Which timezone do the start and end times use?" },
  { field: "landingPageUrl", question: "Which landing page should customers use? It must be on an approved domain." },
  { field: "terms", question: "What are the terms and exclusions (e.g. one per customer, excludes gift cards)?" },
];

export function missingFields(p: Pick<PromotionRow, "discountType" | "discountValue" | "eligibleProductIds" | "eligibleDescription" | "startsAt" | "endsAt" | "timezone" | "landingPageUrl" | "terms">): string[] {
  const m: string[] = [];
  if (!p.discountType || (["percent", "fixed_amount"].includes(p.discountType) && (p.discountValue === null || Number(p.discountValue) <= 0))) m.push("discount");
  if (!p.eligibleProductIds.length && !p.eligibleDescription?.trim()) m.push("eligibleProducts");
  if (!p.startsAt) m.push("startsAt");
  if (!p.endsAt) m.push("endsAt");
  if (!p.timezone) m.push("timezone");
  if (!p.landingPageUrl) m.push("landingPageUrl");
  if (!p.terms?.trim()) m.push("terms");
  return m;
}

export async function createPromotionFromRequest(ctx: Ctx, request: string, name?: string) {
  requirePermission(ctx, "campaigns.write");
  const parsed = parsePromotionRequest(request);
  const products = await listProducts(ctx);
  const hinted = parsed.productHints.length
    ? products.filter((p) => parsed.productHints.some((h) => p.name.toLowerCase().includes(h) || p.keywords.some((k) => k.toLowerCase() === h)))
    : [];
  // A start hint plus duration lets us *propose* times, but they remain unconfirmed until the user saves them.
  const values = {
    workspaceId: ctx.workspaceId,
    name: name ?? (parsed.discountType === "percent" ? `${parsed.discountValue}% off` : parsed.discountType === "fixed_amount" ? `${parsed.currency ?? ""} ${parsed.discountValue} off`.trim() : "New promotion"),
    rawRequest: request.slice(0, 2000),
    discountType: parsed.discountType,
    discountValue: parsed.discountValue !== null ? String(parsed.discountValue) : null,
    currency: parsed.currency,
    eligibleProductIds: hinted.map((p) => p.id),
    eligibleDescription: null,
    durationDays: parsed.durationDays,
    landingPageUrl: parsed.landingPageUrl,
    ownerId: ctx.userId,
    status: "needs_input",
    channelApprovals: { organic: "not_requested", messages: "not_requested", ads: "not_requested", commerce: "not_connected" },
  };
  const [row] = await ctx.tx.insert(s.promotionOffers).values({ ...values, missingFields: [] }).returning();
  const missing = missingFields(row!);
  const [updated] = await ctx.tx.update(s.promotionOffers).set({ missingFields: missing }).where(eq(s.promotionOffers.id, row!.id)).returning();
  await audit(ctx, { action: "promotion.created", targetType: "promotion", targetId: row!.id, metadata: { parsed, missing } });
  return {
    promotion: updated!,
    parsed,
    allProductsMentioned: parsed.allProducts,
    questions: ESSENTIAL_FIELDS.filter((f) => missing.includes(f.field)).map((f) => f.question),
    suggestions: {
      // Proposed, unconfirmed values shown in the form; never auto-saved.
      timezone: (await ctx.tx.select({ tz: s.workspaces.timezone }).from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)))[0]?.tz ?? "UTC",
      startHint: parsed.startHint,
      durationDays: parsed.durationDays,
      durationHours: parsed.durationHours,
    },
  };
}

export async function getPromotion(ctx: Ctx, id: string) {
  requirePermission(ctx, "campaigns.read");
  const r = await ctx.tx.select().from(s.promotionOffers).where(and(eq(s.promotionOffers.id, id), eq(s.promotionOffers.workspaceId, ctx.workspaceId))).limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Promotion not found");
  return r[0];
}

export async function listPromotions(ctx: Ctx) {
  requirePermission(ctx, "campaigns.read");
  return ctx.tx.select().from(s.promotionOffers).where(eq(s.promotionOffers.workspaceId, ctx.workspaceId)).orderBy(desc(s.promotionOffers.createdAt));
}

/**
 * Update offer terms. Any change to terms invalidates approvals on every linked asset, because the
 * approved copy may no longer match the offer.
 */
export async function updatePromotion(ctx: Ctx, id: string, patch: z.infer<typeof promotionPatchSchema>) {
  requirePermission(ctx, "campaigns.write");
  const cur = await getPromotion(ctx, id);
  if (["ended", "cancelled"].includes(cur.status)) throw new AppError("CONFLICT", `Promotion is ${cur.status}`);
  if (patch.eligibleProductIds?.length) {
    const owned = await ctx.tx.select({ id: s.products.id }).from(s.products).where(and(inArray(s.products.id, patch.eligibleProductIds), eq(s.products.workspaceId, ctx.workspaceId)));
    if (owned.length !== new Set(patch.eligibleProductIds).size) throw new AppError("NOT_FOUND", "One or more products were not found");
  }
  if (patch.landingPageUrl) {
    const chk = checkUrl(patch.landingPageUrl, await listAllowedDomains(ctx));
    if (!chk.ok) throw new AppError("VALIDATION_FAILED", `Landing page rejected: ${chk.reason}`);
  }
  const startsAt = patch.startsAt !== undefined ? (patch.startsAt ? new Date(patch.startsAt) : null) : cur.startsAt;
  const endsAt = patch.endsAt !== undefined ? (patch.endsAt ? new Date(patch.endsAt) : null) : cur.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError("VALIDATION_FAILED", "End must be after start");
  if (patch.discountType === "percent" && patch.discountValue !== undefined && patch.discountValue !== null && patch.discountValue > 100) {
    throw new AppError("VALIDATION_FAILED", "Percent discounts cannot exceed 100");
  }
  const next = {
    ...patch,
    discountValue: patch.discountValue === undefined ? undefined : patch.discountValue === null ? null : String(patch.discountValue),
    startsAt,
    endsAt,
    durationDays: startsAt && endsAt ? Math.round((endsAt.getTime() - startsAt.getTime()) / 86400_000) : cur.durationDays,
  };
  const merged = { ...cur, ...next } as PromotionRow;
  const missing = missingFields(merged);
  const status = missing.length ? "needs_input" : endsAt && endsAt < new Date() ? "ended" : startsAt && startsAt <= new Date() ? "active" : "ready";
  const [updated] = await ctx.tx
    .update(s.promotionOffers)
    .set({ ...next, missingFields: missing, status, version: cur.version + 1, updatedAt: new Date() })
    .where(eq(s.promotionOffers.id, id))
    .returning();
  // Invalidate approvals on all linked assets: terms are part of every approved payload.
  const linkedContent = await ctx.tx.select({ id: s.contentItems.id }).from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.promotionId, id)));
  const linkedAds = await ctx.tx.select({ id: s.adCampaigns.id }).from(s.adCampaigns).where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), eq(s.adCampaigns.promotionId, id)));
  let invalidated = 0;
  for (const c of [...linkedContent, ...linkedAds]) invalidated += await invalidateApprovalsForSubject(ctx, c.id, "Promotion terms changed");
  if (endsAt && status !== "needs_input") {
    await enqueue(ctx.tx, { type: "promotion.end", workspaceId: ctx.workspaceId, payload: { promotionId: id, version: updated!.version }, runAt: endsAt, idempotencyKey: `promotion.end:${id}:${updated!.version}`, correlationId: ctx.correlationId });
  }
  await audit(ctx, { action: "promotion.updated", targetType: "promotion", targetId: id, metadata: { fields: Object.keys(patch), missing, invalidatedApprovals: invalidated } });
  return { promotion: updated!, invalidated };
}

// ───────────────────────────── Cross-asset consistency ─────────────────────────────

export interface ConsistencyIssue {
  severity: "block" | "warning";
  asset: string;
  message: string;
}

export function checkOfferConsistency(
  promo: Pick<PromotionRow, "discountType" | "discountValue" | "endsAt" | "landingPageUrl" | "currency">,
  assets: Array<{ label: string; text: string }>,
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const expected = promo.discountValue !== null ? Number(promo.discountValue) : null;
  const landingHost = promo.landingPageUrl ? new URL(promo.landingPageUrl).hostname.replace(/^www\./, "") : null;
  for (const a of assets) {
    const txt = a.text;
    if (promo.discountType === "percent" && expected !== null) {
      const pcts = [...txt.matchAll(/(\d{1,3}(?:\.\d+)?)\s?(?:%|percent)/gi)].map((m) => Number(m[1]));
      for (const p of pcts) if (p !== expected) issues.push({ severity: "block", asset: a.label, message: `States ${p}% but the offer is ${expected}%.` });
      if (!pcts.includes(expected)) issues.push({ severity: "warning", asset: a.label, message: `Does not state the ${expected}% discount.` });
    }
    if (promo.discountType === "fixed_amount" && expected !== null) {
      const amts = [...txt.matchAll(/[$€£₹]\s?(\d+(?:\.\d{1,2})?)\s*off/gi)].map((m) => Number(m[1]));
      for (const v of amts) if (v !== expected) issues.push({ severity: "block", asset: a.label, message: `States ${v} off but the offer is ${expected} off.` });
    }
    if (promo.endsAt && /\b(no end|forever|always on|permanent|while it lasts forever)\b/i.test(txt)) {
      issues.push({ severity: "block", asset: a.label, message: "Implies the offer never ends." });
    }
    if (/\b(guaranteed|lowest price ever|best price guaranteed)\b/i.test(txt)) issues.push({ severity: "warning", asset: a.label, message: "Contains an unsubstantiated price claim." });
    if (landingHost) {
      for (const u of extractUrls(txt)) {
        const host = new URL(u).hostname.replace(/^www\./, "");
        if (host !== landingHost) issues.push({ severity: "warning", asset: a.label, message: `Links to ${host} instead of the offer landing page (${landingHost}).` });
      }
    }
  }
  return issues;
}

export async function promotionReview(ctx: Ctx, id: string) {
  const promo = await getPromotion(ctx, id);
  const content = await ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.promotionId, id)));
  const versions = content.length
    ? await ctx.tx.select().from(s.contentVersions).where(and(eq(s.contentVersions.workspaceId, ctx.workspaceId), inArray(s.contentVersions.contentItemId, content.map((c) => c.id))))
    : [];
  const ads = await ctx.tx.select().from(s.adCampaigns).where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), eq(s.adCampaigns.promotionId, id)));
  const creatives = ads.length ? await ctx.tx.select().from(s.adCreatives).where(inArray(s.adCreatives.adCampaignId, ads.map((a) => a.id))) : [];
  const assets = [
    ...content.map((c) => {
      const v = versions.find((x) => x.contentItemId === c.id && x.version === c.currentVersion);
      return { label: `${c.format}: ${c.title}`, text: `${v?.caption ?? ""} ${v?.cta ?? ""}` };
    }),
    ...creatives.map((c) => ({ label: `Ad creative: ${c.headline}`, text: `${c.headline} ${c.primaryText}` })),
  ];
  const issues = checkOfferConsistency(promo, assets);
  const approvals = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(eq(s.approvalRequests.workspaceId, ctx.workspaceId), inArray(s.approvalRequests.subjectId, [...content.map((c) => c.id), ...ads.map((a) => a.id), id])));
  const channel = (types: string[]) => {
    const rel = approvals.filter((a) => types.includes(a.actionType));
    if (!rel.length) return "not_requested";
    if (rel.every((a) => a.status === "approved" || a.status === "executed")) return "approved";
    if (rel.some((a) => a.status === "pending")) return "pending";
    if (rel.some((a) => a.status === "rejected")) return "rejected";
    return rel[0]!.status;
  };
  return {
    promotion: promo,
    content,
    ads,
    issues,
    channels: {
      organic: channel(["publish_post"]),
      messages: "draft_only",
      ads: channel(["ad_launch"]),
      commerce: promo.commerceStatus,
    },
    notes: {
      messages: "Outbound offer messages are drafts only: Instagram does not allow bulk unsolicited DMs, and no consented email/SMS channel is connected.",
      commerce: "No commerce system is connected. Prices and coupon codes are NOT changed by this platform; apply the discount in your store.",
    },
  };
}

/**
 * Generate coordinated drafts for an offer: feed post, story, reel concept and (optionally) an ads draft.
 * Drafts quote the approved terms verbatim; nothing is scheduled or sent.
 */
export async function planPromotion(ctx: Ctx, id: string, opts: { includeAds: boolean }) {
  requirePermission(ctx, "campaigns.write");
  const promo = await getPromotion(ctx, id);
  if (promo.missingFields.length) throw new AppError("NEEDS_INPUT", "Answer the missing questions before planning", promo.missingFields);
  if (opts.includeAds && !promo.adBudgetMinor) throw new AppError("NEEDS_INPUT", "An ad budget is required to plan ads", ["adBudgetMinor"]);
  const { createContent } = await import("./content");
  const offerLine = offerSentence(promo);
  const products = await listProducts(ctx);
  const eligible = products.filter((p) => promo.eligibleProductIds.includes(p.id));
  const productLine = eligible.length ? eligible.map((p) => p.name).join(", ") : (promo.eligibleDescription ?? "");
  const tz = promo.timezone ?? "UTC";
  const end = promo.endsAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(promo.endsAt) : "";
  const created = [];
  for (const [format, title] of [["post", "Offer announcement"], ["story", "Offer story"], ["reel", "Offer reel concept"]] as const) {
    created.push(
      await createContent(ctx, {
        title: `${promo.name} — ${title}`,
        format,
        status: format === "reel" ? "concept" : "draft",
        promotionId: id,
        productIds: promo.eligibleProductIds.slice(0, 10),
        scheduledAt: promo.startsAt?.toISOString() ?? null,
        timezone: tz,
        version: {
          caption: `${offerLine} on ${productLine}. Ends ${end} (${tz}).\n\n${promo.terms ?? ""}\n${promo.landingPageUrl ?? ""}`.trim(),
          cta: "Shop the offer",
          altText: null,
          hashtags: [],
          language: "en",
          mediaAssetIds: [],
          sourceFactIds: [],
          brief: format === "reel" ? { concept: "3-shot reel: product hero, offer card, CTA end card", offer: offerLine } : null,
          changeNote: "Generated from promotion terms",
        },
      }),
    );
  }
  let adCampaignId: string | null = null;
  if (opts.includeAds) {
    const { createAdDraft } = await import("./ads");
    const days = promo.durationDays && promo.durationDays > 0 ? promo.durationDays : 1;
    const ad = await createAdDraft(ctx, {
      name: `${promo.name} — Meta campaign`,
      objective: "OUTCOME_SALES",
      promotionId: id,
      dailyBudgetMinor: Math.floor(promo.adBudgetMinor! / days),
      currency: promo.currency ?? "USD",
      startsAt: promo.startsAt?.toISOString() ?? null,
      endsAt: promo.endsAt?.toISOString() ?? null,
      timezone: tz,
      destinationUrl: promo.landingPageUrl!,
      audience: { countries: ["US"], ageMin: 18, ageMax: 65, interests: [], rationale: promo.audienceNote ?? "Hypothesis: broad audience; refine with results." },
      placements: ["instagram_feed", "instagram_stories", "instagram_reels"],
      creatives: [{ headline: promo.name.slice(0, 80), primaryText: `${offerLine} on ${productLine}. Ends ${end}.`.slice(0, 500), callToAction: "SHOP_NOW" }],
    });
    adCampaignId = ad.id;
  }
  await audit(ctx, { action: "promotion.planned", targetType: "promotion", targetId: id, metadata: { content: created.length, ads: Boolean(adCampaignId) } });
  return { contentIds: created.map((c) => c.id), adCampaignId };
}

export function offerSentence(p: Pick<PromotionRow, "discountType" | "discountValue" | "currency">) {
  if (p.discountType === "percent") return `${Number(p.discountValue)}% off`;
  if (p.discountType === "fixed_amount") return `${p.currency ?? ""} ${Number(p.discountValue)} off`.trim();
  if (p.discountType === "bogo") return "Buy one, get one";
  if (p.discountType === "free_shipping") return "Free shipping";
  return "Special offer";
}

export async function cancelPromotion(ctx: Ctx, id: string) {
  requirePermission(ctx, "campaigns.write");
  await getPromotion(ctx, id);
  const linked = await ctx.tx.select({ id: s.contentItems.id }).from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.promotionId, id)));
  for (const c of linked) await invalidateApprovalsForSubject(ctx, c.id, "Promotion cancelled");
  await ctx.tx.update(s.promotionOffers).set({ status: "cancelled", updatedAt: new Date() }).where(eq(s.promotionOffers.id, id));
  await audit(ctx, { action: "promotion.cancelled", targetType: "promotion", targetId: id });
}

// ───────────────────────────── End-of-offer enforcement & reconciliation ─────────────────────────────

registerJob("promotion.end", {
  async run(jc, payload) {
    const promotionId = String(payload.promotionId);
    return jc.tenant(async (ctx) => {
      const promo = (await ctx.tx.select().from(s.promotionOffers).where(eq(s.promotionOffers.id, promotionId)).limit(1))[0];
      if (!promo || promo.version !== Number(payload.version) || ["cancelled"].includes(promo.status)) return { skipped: true };
      if (promo.endsAt && promo.endsAt > new Date(Date.now() + 60_000)) return { skipped: "end moved later" };
      // Unschedule organic content that would publish after the offer ended (internal, reversible).
      const content = await ctx.tx.select().from(s.contentItems).where(and(eq(s.contentItems.workspaceId, ctx.workspaceId), eq(s.contentItems.promotionId, promotionId)));
      const unscheduled: string[] = [];
      for (const c of content) {
        if (["scheduled", "approved", "in_review"].includes(c.status)) {
          await invalidateApprovalsForSubject(ctx, c.id, "Promotion ended");
          await ctx.tx.update(s.contentItems).set({ status: "draft", updatedAt: new Date() }).where(eq(s.contentItems.id, c.id));
          unscheduled.push(c.id);
        }
      }
      const publishedAfterEnd = content.filter((c) => c.publishedAt && promo.endsAt && c.publishedAt > promo.endsAt).map((c) => c.id);
      // Ads were created with end_time = offer end, so Meta stops delivery itself; reconcile provider state.
      const ads = await ctx.tx.select().from(s.adCampaigns).where(and(eq(s.adCampaigns.workspaceId, ctx.workspaceId), eq(s.adCampaigns.promotionId, promotionId)));
      const adReport: Array<{ id: string; status: string; providerStatus: string | null; mismatch: boolean }> = [];
      for (const a of ads) {
        let providerStatus = a.providerStatus;
        if (a.externalCampaignId && a.accountId) {
          try {
            const { adsAdapter, getAccount } = await import("./integrations");
            const obj = await (await adsAdapter(ctx, await getAccount(ctx, a.accountId))).getObject(a.externalCampaignId);
            providerStatus = obj.effective_status ?? obj.status ?? null;
            await ctx.tx.update(s.adCampaigns).set({ providerStatus, updatedAt: new Date() }).where(eq(s.adCampaigns.id, a.id));
          } catch (e) {
            providerStatus = `unavailable: ${(e as Error).message.slice(0, 80)}`;
          }
        }
        const mismatch = providerStatus === "ACTIVE";
        adReport.push({ id: a.id, status: a.status, providerStatus, mismatch });
        if (["draft", "pending_approval", "approved"].includes(a.status)) {
          await invalidateApprovalsForSubject(ctx, a.id, "Promotion ended");
        }
      }
      const report = { endedAt: new Date().toISOString(), unscheduled, publishedAfterEnd, ads: adReport, commerce: promo.commerceStatus === "not_connected" ? "No commerce system connected: verify the discount was removed in your store." : promo.commerceStatus };
      await ctx.tx.update(s.promotionOffers).set({ status: "ended", endReconciledAt: new Date(), reconciliationReport: report, updatedAt: new Date() }).where(eq(s.promotionOffers.id, promotionId));
      await audit(ctx, { action: "promotion.ended_reconciled", targetType: "promotion", targetId: promotionId, metadata: report });
      const alerts = adReport.filter((r) => r.mismatch).length + publishedAfterEnd.length;
      await notify(ctx, {
        kind: alerts ? "promotion_reconciliation_alert" : "promotion_ended",
        title: alerts ? `Promotion “${promo.name}” ended with ${alerts} item(s) needing attention` : `Promotion “${promo.name}” ended`,
        body: report.commerce,
        link: `/campaigns?promotion=${promotionId}`,
      });
      return report;
    });
  },
});
